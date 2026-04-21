/**
 * Unit tests — src/engine/runtime_writer.ts (Phase G.1, W-0102)
 *
 * Verifies that the writer:
 *   - emits an initial "startup" snapshot on attach
 *   - emits a fresh snapshot after every engine op (post-debounce)
 *   - uses atomic rename (no tmp files left on disk)
 *   - emits a "stopped" snapshot on detach
 *   - surfaces tamper alarms
 *   - never crashes the engine on write failures
 *
 * All tests use a per-test tempdir so they do not race with the real
 * ops/data/runtime.json or with other tests.
 */
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineState } from "../../../src/engine/state.js";
import {
  RuntimeWriter,
  type RuntimeSnapshot,
} from "../../../src/engine/runtime_writer.js";
import { believe, attest, forget } from "../../../src/engine/ops.js";

let tmpRoot: string;
let outPath: string;
let state: EngineState;
let writer: RuntimeWriter;

function read(): RuntimeSnapshot {
  const raw = readFileSync(outPath, "utf8");
  return JSON.parse(raw) as RuntimeSnapshot;
}

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "weavory-rtw-"));
  outPath = join(tmpRoot, "runtime.json");
  state = new EngineState();
  writer = new RuntimeWriter(state, {
    outPath,
    debounceMs: 10,
    disableExitHandlers: true, // tests must not register process handlers
  });
});

afterEach(() => {
  try {
    writer.detach();
  } catch {
    /* ignore */
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("RuntimeWriter — initial snapshot", () => {
  it("emits a startup snapshot the moment it attaches", () => {
    writer.attach();
    const snap = read();
    expect(snap.schema_version).toBe("1.0.0");
    expect(snap.server_status).toBe("running");
    expect(snap.last_op).toBe("startup");
    expect(snap.pid).toBe(process.pid);
    expect(snap.beliefs_total).toBe(0);
    expect(snap.audit_length).toBe(0);
    expect(snap.tamper_alarm).toBeNull();
  });
});

describe("RuntimeWriter — op snapshots", () => {
  it("reflects a believe op in beliefs_total + last_op (after debounce)", async () => {
    writer.attach();
    believe(state, {
      subject: "s",
      predicate: "p",
      object: "o",
      signer_seed: "alice",
    });
    await sleep(40); // > debounceMs=10
    const snap = read();
    expect(snap.beliefs_total).toBe(1);
    expect(snap.beliefs_live).toBe(1);
    expect(snap.audit_length).toBe(1);
    expect(snap.last_op).toBe("believe");
    expect(snap.last_event_ts).not.toBeNull();
  });

  it("reflects attest + forget in subsequent snapshots", async () => {
    writer.attach();
    const b = believe(state, {
      subject: "s",
      predicate: "p",
      object: "o",
      signer_seed: "alice",
    });
    await sleep(40);
    attest(state, { signer_id: b.signer_id, topic: "p", score: 0.9, attestor_seed: "bob" });
    await sleep(40);
    let snap = read();
    expect(snap.last_op).toBe("attest");
    expect(snap.audit_length).toBe(2);

    forget(state, { belief_id: b.id, forgetter_seed: "alice" });
    await sleep(40);
    snap = read();
    expect(snap.last_op).toBe("forget");
    expect(snap.beliefs_total).toBe(1);
    expect(snap.beliefs_live).toBe(0); // tombstoned
    expect(snap.audit_length).toBe(3);
  });

  it("flushNow bypasses the debounce", () => {
    writer.attach();
    believe(state, { subject: "s", predicate: "p", object: "o", signer_seed: "alice" });
    writer.flushNow();
    const snap = read();
    expect(snap.beliefs_total).toBe(1);
  });
});

describe("RuntimeWriter — atomicity", () => {
  it("leaves only runtime.json on disk — no .tmp* leftovers", async () => {
    writer.attach();
    believe(state, { subject: "s", predicate: "p", object: "o", signer_seed: "alice" });
    await sleep(40);
    const files = readdirSync(tmpRoot);
    expect(files).toContain("runtime.json");
    for (const f of files) {
      expect(f.includes(".tmp")).toBe(false);
    }
  });
});

describe("RuntimeWriter — shutdown", () => {
  it("writes a stopped snapshot on detach", () => {
    writer.attach();
    writer.detach();
    const snap = read();
    expect(snap.server_status).toBe("stopped");
    expect(snap.last_op).toBe("shutdown");
  });
});

describe("RuntimeWriter — tamper alarm", () => {
  it("populates tamper_alarm in the snapshot", () => {
    writer.attach();
    writer.setTamperAlarm({
      detected_at: "2026-04-21T21:30:00Z",
      bad_index: 2,
      reason: "entry_hash mismatch",
    });
    writer.flushNow();
    const snap = read();
    expect(snap.tamper_alarm).not.toBeNull();
    expect(snap.tamper_alarm?.bad_index).toBe(2);
    expect(snap.tamper_alarm?.reason).toContain("entry_hash");

    writer.setTamperAlarm(null);
    writer.flushNow();
    expect(read().tamper_alarm).toBeNull();
  });
});

describe("RuntimeWriter — resilience", () => {
  it("does not crash the engine when the output directory is unwritable", () => {
    // Point the writer at a path whose parent is read-only. On failure the
    // writer must log to stderr but not throw.
    const badWriter = new RuntimeWriter(state, {
      outPath: "/nonexistent-volume/weavory-runtime.json",
      debounceMs: 0,
      disableExitHandlers: true,
    });
    expect(() => badWriter.attach()).not.toThrow();
    // attach flushes synchronously; the bad path should NOT exist.
    expect(existsSync("/nonexistent-volume/weavory-runtime.json")).toBe(false);
    badWriter.detach();
  });
});

describe("RuntimeWriter — idempotent attach / detach", () => {
  it("double-attach is a no-op", () => {
    writer.attach();
    const before = writer.flushCount();
    writer.attach(); // should not double-subscribe
    believe(state, { subject: "s", predicate: "p", object: "o", signer_seed: "alice" });
    writer.flushNow();
    // Exactly one additional flush happened (not two).
    expect(writer.flushCount()).toBe(before + 1);
  });
});
