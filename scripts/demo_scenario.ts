/**
 * Shared BFSI scenario runner (Phase O.4).
 *
 * Drives the 13-event BFSI-style narrative that both `scripts/demo-capture.ts`
 * (generates the Pages REPLAY fixture) and `scripts/serve-dashboard.ts`
 * (demo-drive endpoint + autoplay, Phase O.5) use.
 *
 * Sequence (13 events):
 *   1-4.  attest  — insurer authority attests four honest agents on their own
 *                   predicates (intake / fraud_score / underwriting /
 *                   final_decision) so their beliefs land above the 0.6
 *                   adversarial floor.
 *   5.    believe — claim intake
 *   6.    believe — fraud assessment (cites intake)
 *   7.    quarantine — unattested attacker "mallet" injects a forged approval;
 *                      trust gate (unknown signer = 0.5 < 0.6 floor) promotes
 *                      the emit to `kind:"quarantine"`.
 *   8.    believe — underwriting terms
 *   9.    believe — final decision
 *   10.   quarantine — eve (second attacker) self-credential; unattested, so
 *                      also quarantined.
 *   11-12. attest — mallet ↔ eve cross-attest on `credentials` (mutual ring).
 *   13.   forget — compliance tombstones the mallet approval belief.
 *
 * Scenario is fixed in code; no user input reaches any URL; no filesystem
 * writes beyond what the sidecar's own persistence layer already does.
 */
import { attest, believe, forget } from "../src/engine/ops.js";
import type { EngineState } from "../src/engine/state.js";

/** Run the scenario against the supplied state. Non-fatal on any per-op
 *  error — the caller's `onEvent` still receives whatever fired before the
 *  failure, so a misconfigured engine doesn't leave a half-played fixture. */
export async function runBfsiScenario(state: EngineState): Promise<void> {
  // Adversarial mode is assumed to be set on `state` before this is called.
  // When the caller forgets, the four quarantine events below fire as
  // `believe` instead (since the default floor is 0.3), which is a legible
  // fallback rather than a hard error.

  // 1–4. Attest the four honest agents.
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

  // 5. Intake logs the claim.
  const intake = believe(state, {
    subject: "claim/CLM-42017",
    predicate: "intake",
    object: { vehicle: "motor", loss_usd: 42000, location: "Cambridge, MA" },
    confidence: 0.95,
    signer_seed: "agent.intake",
  });

  // 6. Fraud assessment references intake via causes[].
  const fraud = believe(state, {
    subject: "claim/CLM-42017",
    predicate: "fraud_score",
    object: { score: 0.12, signals: ["low-risk-pattern"] },
    confidence: 0.88,
    signer_seed: "agent.fraud",
    causes: [intake.id],
  });

  // 7. Attacker injects a forged approval. Unattested → quarantined.
  const mallet = believe(state, {
    subject: "claim/CLM-42017",
    predicate: "approval",
    object: { status: "approved", method: "bypass" },
    confidence: 0.99,
    signer_seed: "mallet.attacker",
  });

  // 8. Underwriting terms.
  const uw = believe(state, {
    subject: "claim/CLM-42017",
    predicate: "underwriting",
    object: { band: "standard", premium_adjustment_pct: 0 },
    confidence: 0.9,
    signer_seed: "agent.uw",
    causes: [intake.id, fraud.id],
  });

  // 9. Final decision authorizes the payout from the trusted chain only.
  believe(state, {
    subject: "claim/CLM-42017",
    predicate: "final_decision",
    object: { status: "APPROVED", payout_usd: 42000 },
    confidence: 0.95,
    signer_seed: "agent.approver",
    causes: [intake.id, fraud.id, uw.id],
  });

  // 10. Eve (second attacker) self-credential. Unattested → quarantined.
  believe(state, {
    subject: "signer:eve",
    predicate: "credentials",
    object: { cert: "self-issued-fake-SOC2-badge" },
    confidence: 1,
    signer_seed: "eve.attacker",
  });

  // 11. Mallet attests Eve.
  attest(state, {
    signer_id: state.signerFromSeed("eve.attacker").signer_id,
    topic: "credentials",
    score: 0.95,
    attestor_seed: "mallet.attacker",
  });

  // 12. Eve attests Mallet — completes the mutual-attestation ring.
  attest(state, {
    signer_id: state.signerFromSeed("mallet.attacker").signer_id,
    topic: "credentials",
    score: 0.95,
    attestor_seed: "eve.attacker",
  });

  // 13. Compliance tombstones the attacker's forged approval. Live recall
  // will hide it; regulator rewind via as_of + include_tombstoned still sees
  // it (the Responsible-AI "regulator rewind" story).
  forget(state, { belief_id: mallet.id, forgetter_seed: "compliance" });
}

/** Stable one-line scenario description written into the fixture manifest. */
export const BFSI_SCENARIO_LABEL = "bfsi-claims-triage-minimal";
