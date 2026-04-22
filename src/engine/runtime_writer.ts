/**
 * weavory.ai — runtime snapshot writer (Phase G.1, W-0100)
 *
 * Atomically writes a JSON snapshot of the live EngineState to
 * `ops/data/runtime.json` every time the engine acknowledges an op. The
 * dashboard panel 10 reads this file directly — so panel 10 is "Not collected
 * yet" iff no writer has ever flushed on this machine / for this process.
 *
 * Invariants:
 *   - Single writer per EngineState (per process).
 *   - Writes are debounced (default 50ms) to avoid disk thrash under burst
 *     operations; the in-memory state updates synchronously regardless.
 *   - Writes are atomic: snapshot is serialized to a tmp file, then renamed
 *     onto runtime.json so dashboard readers never see a half-written file.
 *   - A "stopped" snapshot is flushed on beforeExit / SIGINT / SIGTERM so the
 *     dashboard can reflect graceful shutdowns; ungraceful exits (SIGKILL,
 *     crash) leave runtime.json with its last-running state — readers detect
 *     staleness via the `updated_at` + `pid` fields.
 *   - Failed disk writes never crash the engine; they are logged to stderr.
 */
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineOp, EngineState } from "./state.js";

// Re-export so downstream callers that used to import from runtime_writer
// keep working without touching their import paths.
export type { EngineOp } from "./state.js";

export type TamperAlarm = {
  detected_at: string;
  bad_index: number;
  reason: string;
};

export type RuntimeSnapshot = {
  schema_version: "1.0.0";
  updated_at: string;
  pid: number;
  server_status: "running" | "stopped";
  beliefs_total: number;
  beliefs_live: number;
  active_subscriptions: number;
  quarantine_count: number;
  audit_length: number;
  last_event_ts: string | null;
  last_op: EngineOp;
  tamper_alarm: TamperAlarm | null;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUT = resolve(REPO_ROOT, "ops/data/runtime.json");

export type RuntimeWriterOptions = {
  /** Output path; defaults to <repo>/ops/data/runtime.json */
  outPath?: string;
  /** Debounce window for file writes, in milliseconds. Default: 50. */
  debounceMs?: number;
  /** If true, do not install process-exit handlers. Default: false. */
  disableExitHandlers?: boolean;
};

export class RuntimeWriter {
  readonly #state: EngineState;
  readonly #outPath: string;
  readonly #debounceMs: number;
  readonly #disableExitHandlers: boolean;

  #attached = false;
  #exitHandlersInstalled = false;
  #pendingTimer: ReturnType<typeof setTimeout> | null = null;
  #lastOp: EngineOp = "startup";
  #lastEventTs: string | null = null;
  #tamperAlarm: TamperAlarm | null = null;
  #flushCount = 0;

  constructor(state: EngineState, opts: RuntimeWriterOptions = {}) {
    this.#state = state;
    this.#outPath = opts.outPath ?? DEFAULT_OUT;
    this.#debounceMs = Math.max(0, opts.debounceMs ?? 50);
    this.#disableExitHandlers = opts.disableExitHandlers ?? false;
  }

  /** Wire the writer into state.onOp. Idempotent per-state. */
  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    this.#state.onOp = (op: EngineOp): void => this.recordOp(op);
    if (!this.#disableExitHandlers) this.#installExitHandlers();
    // Emit an initial running snapshot so the dashboard reflects process start
    // even before the first op.
    this.#writeNow("startup", "running");
  }

  /** Detach + flush a final "stopped" snapshot. */
  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.#state.onOp = undefined;
    if (this.#pendingTimer) {
      clearTimeout(this.#pendingTimer);
      this.#pendingTimer = null;
    }
    this.#writeNow("shutdown", "stopped");
  }

  /** Record an op; schedules a debounced flush. */
  recordOp(op: EngineOp): void {
    this.#lastOp = op;
    this.#lastEventTs = new Date().toISOString();
    this.#schedule();
  }

  /** Raise a tamper alarm visible to the dashboard. */
  setTamperAlarm(alarm: TamperAlarm | null): void {
    this.#tamperAlarm = alarm;
    this.#schedule();
  }

  /** Debounced count of flushes — useful for tests. */
  flushCount(): number {
    return this.#flushCount;
  }

  /** Force a synchronous flush (bypassing the debounce timer). */
  flushNow(): void {
    if (this.#pendingTimer) {
      clearTimeout(this.#pendingTimer);
      this.#pendingTimer = null;
    }
    this.#writeNow(this.#lastOp, "running");
  }

  #schedule(): void {
    if (this.#pendingTimer) return;
    this.#pendingTimer = setTimeout(() => {
      this.#pendingTimer = null;
      this.#writeNow(this.#lastOp, "running");
    }, this.#debounceMs);
    // Don't keep the event loop alive solely for a runtime snapshot — the
    // process should be able to exit even if a debounce is pending.
    this.#pendingTimer.unref?.();
  }

  #installExitHandlers(): void {
    if (this.#exitHandlersInstalled) return;
    this.#exitHandlersInstalled = true;
    const onExit = (): void => {
      try {
        this.#writeNow("shutdown", "stopped");
      } catch {
        // Ignore: the process is exiting anyway.
      }
    };
    process.on("beforeExit", onExit);
    // Per-signal handler: do the flush, then re-raise so whichever Node
    // default / user-registered handler takes over. `process.once` removes
    // *our* handler automatically after it fires — so the re-raised signal
    // hits either another registered handler or Node's default (terminate).
    // We deliberately do NOT call `process.removeAllListeners(signal)` here:
    // that would wipe listeners other code registered before ours.
    const onSignal = (signal: NodeJS.Signals): void => {
      onExit();
      process.kill(process.pid, signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  #buildSnapshot(op: EngineOp, status: "running" | "stopped"): RuntimeSnapshot {
    let beliefs_live = 0;
    let quarantine_count = 0;
    for (const b of this.#state.beliefs.values()) {
      if (!b.invalidated_at) beliefs_live++;
      if (b.quarantined) quarantine_count++;
    }
    return {
      schema_version: "1.0.0",
      updated_at: new Date().toISOString(),
      pid: process.pid,
      server_status: status,
      beliefs_total: this.#state.beliefs.size,
      beliefs_live,
      active_subscriptions: this.#state.subscriptions.size,
      quarantine_count,
      audit_length: this.#state.audit.length(),
      last_event_ts: this.#lastEventTs,
      last_op: op,
      tamper_alarm: this.#tamperAlarm,
    };
  }

  #writeNow(op: EngineOp, status: "running" | "stopped"): void {
    try {
      const snap = this.#buildSnapshot(op, status);
      mkdirSync(dirname(this.#outPath), { recursive: true });
      const tmp = `${this.#outPath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n", "utf8");
      renameSync(tmp, this.#outPath);
      this.#flushCount++;
    } catch (err) {
      // Never crash the engine on a snapshot failure. Log and keep going.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[runtime_writer] snapshot write failed: ${msg}\n`);
    }
  }
}
