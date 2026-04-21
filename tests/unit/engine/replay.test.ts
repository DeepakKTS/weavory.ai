/**
 * Unit tests — src/engine/replay.ts (Phase G.4, W-0130)
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineState } from "../../../src/engine/state.js";
import { believe } from "../../../src/engine/ops.js";
import { exportIncident } from "../../../src/engine/incident.js";
import { loadIncident, rehydrateState, runReplay } from "../../../src/engine/replay.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "weavory-replay-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function newEngineWithBeliefs(): EngineState {
  const s = new EngineState();
  const b1 = believe(s, {
    subject: "scenario:traffic",
    predicate: "observation",
    object: { congested: true, eta_delta_min: 14 },
    signer_seed: "alice",
  });
  const b2 = believe(s, {
    subject: "scenario:weather",
    predicate: "observation",
    object: { temp_c: 12 },
    signer_seed: "bob",
  });
  s.setTrust(b1.signer_id, "observation", 0.9);
  s.setTrust(b2.signer_id, "observation", 0.7);
  return s;
}

describe("loadIncident", () => {
  it("reads a written incident file and preserves structure", () => {
    const s = newEngineWithBeliefs();
    const { path, incident_id } = exportIncident(s, {
      outDir: tmp,
      reason: "unit-test",
    });
    const loaded = loadIncident(path);
    expect(loaded.record.incident_id).toBe(incident_id);
    expect(loaded.record.schema_version).toBe("1.0.0");
    expect(loaded.record.beliefs.total).toBe(2);
    expect(loaded.record.audit.length).toBe(2);
    expect(loaded.record.audit.verify.ok).toBe(true);
  });

  it("throws on unsupported schema_version", () => {
    const s = newEngineWithBeliefs();
    const { path } = exportIncident(s, { outDir: tmp });
    // Corrupt the schema_version.
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.schema_version = "9.9.9";
    const badPath = join(tmp, "bad.json");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(badPath, JSON.stringify(raw), "utf8");
    expect(() => loadIncident(badPath)).toThrow(/unsupported/);
  });
});

describe("rehydrateState", () => {
  it("rehydrates beliefs + audit + trust + adversarial_mode from a clean export", () => {
    const src = newEngineWithBeliefs();
    src.adversarialMode = true;
    const { path } = exportIncident(src, { outDir: tmp });
    const { record } = loadIncident(path);
    const replay = rehydrateState(record);

    expect(replay.beliefs.size).toBe(2);
    expect(replay.audit.length()).toBe(2);
    expect(replay.audit.verify().ok).toBe(true);
    expect(replay.adversarialMode).toBe(true);
    // Trust is preserved.
    const someSigner = Array.from(replay.trust.keys())[0];
    const v = replay.trust.get(someSigner);
    expect(v?.size).toBeGreaterThan(0);
  });

  it("preserves a tampered chain faithfully (verify.ok=false after rehydrate)", () => {
    const src = newEngineWithBeliefs();
    src.audit._adversarialMutate(0, (e) => ({ ...e, belief_id: "0".repeat(64) }));
    const { path } = exportIncident(src, { outDir: tmp });
    const { record } = loadIncident(path);
    const replay = rehydrateState(record);
    expect(replay.audit.verify().ok).toBe(false);
  });
});

describe("runReplay", () => {
  it("runs a recall and returns a summary + recall result", () => {
    const src = newEngineWithBeliefs();
    const { path } = exportIncident(src, { outDir: tmp });
    const { record } = loadIncident(path);
    const state = rehydrateState(record);

    const r = runReplay(state, record, { query: "traffic" });
    expect(r.summary.incident_id).toBe(record.incident_id);
    expect(r.summary.beliefs.total).toBe(2);
    expect(r.recall.total_matched).toBeGreaterThanOrEqual(1);
    expect(r.recall.beliefs[0].subject).toBe("scenario:traffic");
  });

  it("defaults min_trust=-1 so replay shows the full audit view", () => {
    const src = new EngineState();
    // Unknown signer (trust defaults to 0.5) would be filtered at the
    // live default 0.3... actually 0.5 > 0.3 so visible — but at
    // adversarial 0.6 it would be filtered. Replay default -1 bypasses.
    src.adversarialMode = true;
    believe(src, { subject: "x", predicate: "p", object: 1, signer_seed: "alice" });
    const { path } = exportIncident(src, { outDir: tmp });
    const { record } = loadIncident(path);
    const state = rehydrateState(record);

    const r = runReplay(state, record, { query: "x" });
    expect(r.recall.total_matched).toBe(1);
  });

  it("honors as_of on a post-export timestamp (sees the full captured state)", () => {
    const src = newEngineWithBeliefs();
    const { path } = exportIncident(src, { outDir: tmp });
    const { record } = loadIncident(path);
    const state = rehydrateState(record);
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = runReplay(state, record, { query: "", as_of: future });
    expect(r.recall.total_matched).toBe(2);
  });
});
