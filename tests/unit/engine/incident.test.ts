/**
 * Unit tests — Phase G.3 tamper detection + incident export
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineState } from "../../../src/engine/state.js";
import { RuntimeWriter } from "../../../src/engine/runtime_writer.js";
import { exportIncident, scanForTamper } from "../../../src/engine/incident.js";
import { believe } from "../../../src/engine/ops.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "weavory-incident-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("scanForTamper (W-0121)", () => {
  it("returns ok:true for a clean chain and clears any prior alarm", () => {
    const s = new EngineState();
    believe(s, { subject: "x", predicate: "p", object: 1, signer_seed: "alice" });

    const writer = new RuntimeWriter(s, {
      outPath: join(tmp, "runtime.json"),
      debounceMs: 0,
      disableExitHandlers: true,
    });
    writer.attach();
    writer.setTamperAlarm({
      detected_at: "2026-04-21T22:00:00Z",
      bad_index: 3,
      reason: "stale",
    });
    const r = scanForTamper(s, writer);
    expect(r.ok).toBe(true);
    expect(r.length).toBe(1);
    expect(r.alarm).toBeNull();
    writer.flushNow();
    const snap = JSON.parse(readFileSync(join(tmp, "runtime.json"), "utf8"));
    expect(snap.tamper_alarm).toBeNull();
    writer.detach();
  });

  it("detects a mutated entry and pushes alarm to RuntimeWriter", () => {
    const s = new EngineState();
    believe(s, { subject: "x", predicate: "p", object: 1, signer_seed: "alice" });
    believe(s, { subject: "y", predicate: "p", object: 2, signer_seed: "alice" });
    believe(s, { subject: "z", predicate: "p", object: 3, signer_seed: "alice" });
    // Corrupt entry 1's belief_id without recomputing hashes.
    s.audit._adversarialMutate(1, (e) => ({ ...e, belief_id: "0".repeat(64) }));

    const writer = new RuntimeWriter(s, {
      outPath: join(tmp, "runtime.json"),
      debounceMs: 0,
      disableExitHandlers: true,
    });
    writer.attach();

    const r = scanForTamper(s, writer);
    expect(r.ok).toBe(false);
    expect(r.alarm).not.toBeNull();
    expect(r.alarm?.bad_index).toBe(1);
    expect(r.alarm?.reason).toBe("entry_hash");

    writer.flushNow();
    const snap = JSON.parse(readFileSync(join(tmp, "runtime.json"), "utf8"));
    expect(snap.tamper_alarm?.bad_index).toBe(1);
    expect(snap.tamper_alarm?.reason).toBe("entry_hash");
    writer.detach();
  });
});

describe("exportIncident (W-0122)", () => {
  it("writes a complete snapshot and returns the path + id", () => {
    const s = new EngineState();
    const b1 = believe(s, {
      subject: "s1",
      predicate: "p",
      object: "one",
      signer_seed: "alice",
    });
    const b2 = believe(s, {
      subject: "s2",
      predicate: "p",
      object: "two",
      signer_seed: "bob",
    });
    s.setTrust(b1.signer_id, "p", 0.9);
    s.setTrust(b2.signer_id, "p", 0.2);

    const { path, incident_id } = exportIncident(s, {
      reason: "unit-test",
      outDir: tmp,
    });
    expect(path).toContain(tmp);
    expect(incident_id).toMatch(/^incident-\d{8}T\d{6}$/);

    const rec = JSON.parse(readFileSync(path, "utf8"));
    expect(rec.schema_version).toBe("1.0.0");
    expect(rec.reason).toBe("unit-test");
    expect(rec.audit.length).toBe(2);
    expect(rec.audit.entries).toHaveLength(2);
    expect(rec.audit.verify.ok).toBe(true);
    expect(rec.beliefs.total).toBe(2);
    expect(rec.beliefs.live).toBe(2);
    expect(rec.trust).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signer_id: b1.signer_id, topic: "p", score: 0.9 }),
        expect.objectContaining({ signer_id: b2.signer_id, topic: "p", score: 0.2 }),
      ])
    );
  });

  it("records a broken chain when verify fails", () => {
    const s = new EngineState();
    believe(s, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    believe(s, { subject: "s", predicate: "p", object: 2, signer_seed: "alice" });
    s.audit._adversarialMutate(1, (e) => ({ ...e, belief_id: "0".repeat(64) }));

    const { path } = exportIncident(s, { outDir: tmp, reason: "tampered" });
    const rec = JSON.parse(readFileSync(path, "utf8"));
    expect(rec.audit.verify.ok).toBe(false);
    expect(rec.audit.verify.bad_index).toBe(1);
  });
});
