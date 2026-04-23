/**
 * Record a short BFSI-style scenario against a fresh EngineState, capture
 * every StreamEvent emitted, and write `ops/data/demo-fixtures.json` for the
 * demo dashboard to replay on GitHub Pages (where there's no live sidecar).
 *
 * Run:  pnpm demo:capture
 *
 * Output shape:
 *   {
 *     captured_at: "2026-04-23T..."
 *     commit:      "<git sha>",
 *     events: [StreamEvent, ...]
 *   }
 *
 * N.4 (BFSI deepening) will replace this scripted walk with a capture of
 * the full `examples/bfsi_claims_triage.ts` run including Scenes 7–8
 * (regulator rewind + collusion-ring detection). For now this gives Pages
 * visitors a legible non-empty fixture so the replay mode has motion.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { EngineState } from "../src/engine/state.js";
import { believe, attest, forget } from "../src/engine/ops.js";
import type { StreamEvent } from "../src/engine/stream_event.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = resolve(REPO_ROOT, "ops/data/demo-fixtures.json");

function commitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

function main(): void {
  const state = new EngineState();
  state.adversarialMode = true;
  const events: StreamEvent[] = [];
  state.onEvent = (e): void => {
    events.push(e);
  };

  // ─── Minimal BFSI-style narrative ────────────────────────────────────
  // Trust setup FIRST so the four honest agents publish above the 0.6
  // adversarial floor (their beliefs show as `believe`, not `quarantine`).
  // Only the attacker's belief lights up the quarantine LED.
  for (const [seed, topic] of [
    ["agent.intake", "intake"],
    ["agent.fraud", "fraud_score"],
    ["agent.uw", "underwriting"],
    ["agent.approver", "final_decision"],
  ] as const) {
    attest(state, {
      signer_id: state.signerFromSeed(seed).signer_id,
      topic,
      score: 0.85,
      attestor_seed: "insurer.authority",
    });
  }

  // Honest pipeline: intake → fraud → underwriting → approver.
  const intake = believe(state, {
    subject: "claim/CLM-42017",
    predicate: "intake",
    object: { vehicle: "motor", loss_usd: 42000, location: "Cambridge, MA" },
    confidence: 0.95,
    signer_seed: "agent.intake",
  });
  const fraud = believe(state, {
    subject: "claim/CLM-42017",
    predicate: "fraud_score",
    object: { score: 0.12, signals: ["low-risk-pattern"] },
    confidence: 0.88,
    signer_seed: "agent.fraud",
    causes: [intake.id],
  });

  // Attacker injects a forged "approval" without attestation — under
  // adversarial mode (floor 0.6, unknown signer 0.5) this fires `quarantine`.
  believe(state, {
    subject: "claim/CLM-42017",
    predicate: "approval",
    object: { status: "approved", method: "bypass" },
    confidence: 0.99,
    signer_seed: "mallet.attacker",
  });

  const uw = believe(state, {
    subject: "claim/CLM-42017",
    predicate: "underwriting",
    object: { band: "standard", premium_adjustment_pct: 0 },
    confidence: 0.9,
    signer_seed: "agent.uw",
    causes: [intake.id, fraud.id],
  });

  const finalDecision = believe(state, {
    subject: "claim/CLM-42017",
    predicate: "final_decision",
    object: { status: "APPROVED", payout_usd: 42000 },
    confidence: 0.95,
    signer_seed: "agent.approver",
    causes: [intake.id, fraud.id, uw.id],
  });

  // Forget the fraud belief to show the tombstone path.
  forget(state, { belief_id: fraud.id, forgetter_seed: "insurer.authority" });

  void finalDecision;

  // ─── Write the fixture ───────────────────────────────────────────────
  const fixture = {
    schema_version: "1.0.0",
    captured_at: new Date().toISOString(),
    commit: commitSha(),
    events,
    event_count: events.length,
    scenario: "bfsi-claims-triage-minimal",
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");
  process.stdout.write(
    `[demo-capture] wrote ${events.length} events → ${OUT_PATH.replace(REPO_ROOT + "/", "")}\n`
  );
}

main();
