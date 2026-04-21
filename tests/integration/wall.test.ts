/**
 * Integration tests — Phase G.3 The Wall
 *
 * Covers adversarial mode (W-0120) + tamper-alarm + incident export from the
 * engine's perspective. The stock-agent demo lives in examples/wall_incident.ts
 * and is verified separately by scripts/verify/gate_wall.sh.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineState } from "../../src/engine/state.js";
import { RuntimeWriter } from "../../src/engine/runtime_writer.js";
import { believe, recall } from "../../src/engine/ops.js";
import { scanForTamper, exportIncident } from "../../src/engine/incident.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "weavory-wall-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("adversarial mode (W-0120)", () => {
  it("default recall filters more aggressively when adversarialMode is on", () => {
    const s = new EngineState();
    // Alice writes without any attestation → her signer's trust is the
    // neutral default (0.5).
    believe(s, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });

    // Normal mode: default min_trust=0.3, neutral 0.5 passes → 1 match.
    expect(recall(s, { query: "s" }).total_matched).toBe(1);

    // Adversarial mode: default min_trust bumps to 0.6, neutral 0.5 fails → 0.
    s.adversarialMode = true;
    expect(recall(s, { query: "s" }).total_matched).toBe(0);

    // Caller can still opt into the audit view.
    expect(recall(s, { query: "s", min_trust: -1 }).total_matched).toBe(1);
  });

  it("attested signers remain visible in adversarial mode", () => {
    const s = new EngineState();
    const b = believe(s, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    s.setTrust(b.signer_id, "p", 0.9);
    s.adversarialMode = true;
    expect(recall(s, { query: "s" }).total_matched).toBe(1);
  });
});

describe("tamper + export end-to-end (W-0121 + W-0122)", () => {
  it("mutating an audit entry fires the alarm and incident export records the break", () => {
    const s = new EngineState();
    s.adversarialMode = true;
    believe(s, { subject: "s1", predicate: "p", object: "a", signer_seed: "alice" });
    believe(s, { subject: "s2", predicate: "p", object: "b", signer_seed: "alice" });
    believe(s, { subject: "s3", predicate: "p", object: "c", signer_seed: "alice" });

    const writer = new RuntimeWriter(s, {
      outPath: join(tmp, "runtime.json"),
      debounceMs: 0,
      disableExitHandlers: true,
    });
    writer.attach();

    // Pre-tamper scan is clean.
    expect(scanForTamper(s, writer).ok).toBe(true);

    // Attacker flips a belief_id in an existing entry.
    s.audit._adversarialMutate(1, (e) => ({ ...e, belief_id: "0".repeat(64) }));

    const scan = scanForTamper(s, writer);
    expect(scan.ok).toBe(false);
    expect(scan.alarm?.bad_index).toBe(1);

    // Incident export captures the state with verify.ok=false.
    const { path } = exportIncident(s, { outDir: tmp, reason: "tamper-drill" });
    expect(path).toContain(tmp);
    const files = readdirSync(tmp);
    expect(files.filter((f) => f.startsWith("incident-"))).toHaveLength(1);

    writer.detach();
  });
});
