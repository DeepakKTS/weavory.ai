/**
 * weavory.ai — adversarial-mode tamper detection + incident export
 * (Phase G.3, W-0121 + W-0122)
 *
 * Two pure operations:
 *
 *   `scanForTamper(state, writer?)` walks the audit chain via
 *   `state.audit.verify()`. On failure, pushes a `TamperAlarm` into the
 *   runtime writer so dashboard panel 10 surfaces it immediately. Never
 *   throws — the engine keeps serving even when the chain is compromised.
 *
 *   `exportIncident(state, reason?)` writes a point-in-time snapshot to
 *   `ops/data/incidents/incident-<timestamp>.json`. Atomic (tmp + rename);
 *   directory created if missing. Captures the full audit chain, every
 *   stored belief, every trust attestation, and every quarantined belief,
 *   so a responder can replay the incident off-process.
 *
 * Both operations are plain functions — EngineState doesn't depend on them,
 * so Phase-1 code keeps running unchanged.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineState } from "./state.js";
import type { RuntimeWriter, TamperAlarm } from "./runtime_writer.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_INCIDENTS_DIR = resolve(REPO_ROOT, "ops/data/incidents");

export type TamperScanResult = {
  ok: boolean;
  length: number;
  alarm: TamperAlarm | null;
};

/**
 * Verify the audit chain. On failure, optionally push a `TamperAlarm` into
 * the given RuntimeWriter so the dashboard shows the break without a
 * separate polling loop. Returns the structured result.
 */
export function scanForTamper(
  state: EngineState,
  writer?: RuntimeWriter
): TamperScanResult {
  const vr = state.audit.verify();
  if (vr.ok) {
    writer?.setTamperAlarm(null);
    return { ok: true, length: vr.length, alarm: null };
  }
  const alarm: TamperAlarm = {
    detected_at: new Date().toISOString(),
    bad_index: vr.bad_index,
    reason: vr.reason,
  };
  writer?.setTamperAlarm(alarm);
  return { ok: false, length: state.audit.length(), alarm };
}

export type IncidentRecord = {
  schema_version: "1.0.0";
  incident_id: string;
  exported_at: string;
  reason: string | null;
  adversarial_mode: boolean;
  audit: {
    length: number;
    verify: { ok: true; length: number } | { ok: false; bad_index: number; reason: string };
    entries: ReturnType<EngineState["audit"]["entries"]>;
  };
  beliefs: {
    total: number;
    live: number;
    quarantined: number;
    tombstoned: number;
    records: unknown[];
  };
  trust: Array<{ signer_id: string; topic: string; score: number }>;
  subscriptions: Array<{ id: string; pattern: string; matches_since_created: number; dropped_count: number; queue_length: number }>;
};

export type ExportIncidentOptions = {
  reason?: string;
  /** Override the output directory. Default: ops/data/incidents/ */
  outDir?: string;
};

export type ExportIncidentResult = {
  path: string;
  incident_id: string;
};

/**
 * Serialize a point-in-time incident record atomically to disk. Returns the
 * resolved path and the incident id. Callers can then expose the file via
 * the dashboard, e-mail it to a responder, or re-ingest it for replay.
 */
export function exportIncident(
  state: EngineState,
  opts: ExportIncidentOptions = {}
): ExportIncidentResult {
  const exported_at = new Date().toISOString();
  const incident_id =
    "incident-" + exported_at.replace(/[^0-9T]/g, "").slice(0, 15);
  const outDir = opts.outDir ?? DEFAULT_INCIDENTS_DIR;
  const outPath = resolve(outDir, `${incident_id}.json`);

  const vr = state.audit.verify();
  const verify =
    vr.ok
      ? ({ ok: true, length: vr.length } as const)
      : ({ ok: false, bad_index: vr.bad_index, reason: vr.reason } as const);

  const beliefRecords = Array.from(state.beliefs.values());
  const trust: IncidentRecord["trust"] = [];
  for (const [signer_id, topicMap] of state.trust) {
    for (const [topic, score] of topicMap) {
      trust.push({ signer_id, topic, score });
    }
  }
  const subscriptions: IncidentRecord["subscriptions"] = Array.from(
    state.subscriptions.values()
  ).map((s) => ({
    id: s.id,
    pattern: s.pattern,
    matches_since_created: s.matches_since_created,
    dropped_count: s.dropped_count,
    queue_length: s.queue.length,
  }));

  let live = 0;
  let quarantined = 0;
  let tombstoned = 0;
  for (const b of beliefRecords) {
    if (b.invalidated_at) tombstoned++;
    else live++;
    if (b.quarantined) quarantined++;
  }

  const record: IncidentRecord = {
    schema_version: "1.0.0",
    incident_id,
    exported_at,
    reason: opts.reason ?? null,
    adversarial_mode: state.adversarialMode,
    audit: {
      length: state.audit.length(),
      verify,
      entries: state.audit.entries(),
    },
    beliefs: {
      total: beliefRecords.length,
      live,
      quarantined,
      tombstoned,
      records: beliefRecords,
    },
    trust,
    subscriptions,
  };

  mkdirSync(outDir, { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  renameSync(tmp, outPath);
  return { path: outPath, incident_id };
}
