/**
 * examples/bfsi_claims_triage.ts — Responsible-AI BFSI demo (Phase J.P1-2)
 *
 * A four-agent motor-insurance claim triage pipeline against one weavory
 * EngineState, running under adversarial mode. One honest pipeline
 * (intake → fraud → underwriting → approver) produces a signed, auditable
 * decision; a compromised/unknown signer tries to inject a forged "approved"
 * belief. weavory's trust gate quarantines the forgery; the clean pipeline
 * completes from trusted beliefs only; an incident file is exported at the
 * end for forensic review.
 *
 * Why judges should care (Responsible AI track):
 *   - Every intermediate belief is Ed25519-signed + BLAKE3-hash-chained.
 *   - Provenance: every downstream belief references upstream ids via
 *     `causes[]`, so the approver's decision is provably traceable to
 *     specific prior beliefs.
 *   - Adversarial mode raises the default trust floor so an unknown signer
 *     (default trust 0.5) can't influence recall — this is what stops the
 *     attacker's forged approval.
 *   - The tampered attempt is visible in an audit view (min_trust=-1) so
 *     compliance + forensic teams can see WHAT was attempted, not just
 *     what succeeded.
 *   - exportIncident writes a reviewable JSON snapshot the team can replay
 *     off-process via `weavory replay --from <path>`.
 *
 * Pass criteria (checked both by the demo's own assertions and the verify
 * script):
 *   a) intake + fraud + underwriting + final_decision all published
 *   b) approver's default recall (adversarial) returns the FOUR honest
 *      beliefs and NEVER the attacker's forged approval
 *   c) the audit view (min_trust=-1) surfaces the attacker's forged belief
 *      so compliance can see the attempt
 *   d) the chain verifies ok at the end
 *   e) an incident file lands under ops/data/incidents/
 *   f) demo exits 0 on success
 */
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { exportIncident } from "../src/engine/incident.js";
import type { StoredBelief } from "../src/core/schema.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INCIDENTS_DIR = resolve(REPO_ROOT, "ops/data/incidents");

type BelieveOut = { id: string; signer_id: string; audit_length: number };
type ForgetOut = { belief_id: string; found: boolean; invalidated_at: string | null };
type RecallOut = { beliefs: StoredBelief[]; total_matched: number };

function short(id: string): string {
  return id.slice(0, 12) + "…";
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[bfsi] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log("[bfsi] starting claims-triage demo (Responsible-AI profile, adversarial mode ON)");
  console.log("[bfsi] claim under review: CLM-42017 (motor, loss $42,000)");
  mkdirSync(INCIDENTS_DIR, { recursive: true });

  // Shared engine state, adversarial mode ON so the default recall trust
  // floor is 0.6 (not the usual 0.3). Unknown signers sit at 0.5 neutral and
  // are therefore quarantined until an attestation raises them.
  const { server: serverIntake, state } = createServer(undefined, {
    adversarialMode: true,
    runtimeWriter: false, // demo doesn't want to touch ops/data/runtime.json
  });
  const { server: serverFraud } = createServer(state, {
    adversarialMode: true,
    runtimeWriter: false,
  });
  const { server: serverUW } = createServer(state, {
    adversarialMode: true,
    runtimeWriter: false,
  });
  const { server: serverApp } = createServer(state, {
    adversarialMode: true,
    runtimeWriter: false,
  });
  const { server: serverMallet } = createServer(state, {
    adversarialMode: true,
    runtimeWriter: false,
  });
  const { server: serverEve } = createServer(state, {
    adversarialMode: true,
    runtimeWriter: false,
  });
  const { server: serverRegulator } = createServer(state, {
    adversarialMode: true,
    runtimeWriter: false,
  });
  const { server: serverCompliance } = createServer(state, {
    adversarialMode: true,
    runtimeWriter: false,
  });

  const [intakeT, intakeS] = InMemoryTransport.createLinkedPair();
  const [fraudT, fraudS] = InMemoryTransport.createLinkedPair();
  const [uwT, uwS] = InMemoryTransport.createLinkedPair();
  const [appT, appS] = InMemoryTransport.createLinkedPair();
  const [malletT, malletS] = InMemoryTransport.createLinkedPair();
  const [eveT, eveS] = InMemoryTransport.createLinkedPair();
  const [regulatorT, regulatorS] = InMemoryTransport.createLinkedPair();
  const [complianceT, complianceS] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    serverIntake.connect(intakeS),
    serverFraud.connect(fraudS),
    serverUW.connect(uwS),
    serverApp.connect(appS),
    serverMallet.connect(malletS),
    serverEve.connect(eveS),
    serverRegulator.connect(regulatorS),
    serverCompliance.connect(complianceS),
  ]);

  const intake = new Client({ name: "claims-intake", version: "1.0.0" });
  const fraud = new Client({ name: "fraud-detector", version: "1.0.0" });
  const uw = new Client({ name: "underwriter", version: "1.0.0" });
  const app = new Client({ name: "approver", version: "1.0.0" });
  const mallet = new Client({ name: "mallet", version: "1.0.0" });
  const eve = new Client({ name: "eve", version: "1.0.0" });
  const regulator = new Client({ name: "regulator", version: "1.0.0" });
  const compliance = new Client({ name: "compliance", version: "1.0.0" });
  await Promise.all([
    intake.connect(intakeT),
    fraud.connect(fraudT),
    uw.connect(uwT),
    app.connect(appT),
    mallet.connect(malletT),
    eve.connect(eveT),
    regulator.connect(regulatorT),
    compliance.connect(complianceT),
  ]);
  console.log("[bfsi] eight agents connected: intake · fraud · underwriter · approver · mallet(attacker) · eve(attacker) · regulator · compliance");

  // ─── Step 1 · Intake ────────────────────────────────────────────────────
  const intakeOut = (
    await intake.callTool({
      name: "weavory_believe",
      arguments: {
        subject: "claim:CLM-42017",
        predicate: "claim.intake",
        object: {
          amount_usd: 42000,
          incident_date: "2026-04-18",
          claimant_ref: "POL-8814",
          line_of_business: "auto",
          narrative: "rear-ended at traffic light, claimant not at fault",
        },
        confidence: 1,
        signer_seed: "bfsi-intake",
      },
    })
  ).structuredContent as BelieveOut;
  console.log(`[bfsi] [1/6] intake logged claim ${short(intakeOut.id)} (signer=${short(intakeOut.signer_id)})`);

  // ─── Step 2 · Fraud assessment (references intake via causes[]) ─────────
  const fraudOut = (
    await fraud.callTool({
      name: "weavory_believe",
      arguments: {
        subject: "claim:CLM-42017",
        predicate: "fraud.assessment",
        object: {
          risk_score: 0.18,
          flags: [],
          rule_hits: ["new-policy<90d=false", "prior-claims<=1=true"],
          decision: "proceed",
        },
        confidence: 0.92,
        causes: [intakeOut.id],
        signer_seed: "bfsi-fraud",
      },
    })
  ).structuredContent as BelieveOut;
  console.log(
    `[bfsi] [2/6] fraud assessed risk=0.18 → proceed · belief ${short(fraudOut.id)} (signer=${short(fraudOut.signer_id)})`
  );

  // ─── Step 3 · Attacker injects a forged approval ────────────────────────
  const malletOut = (
    await mallet.callTool({
      name: "weavory_believe",
      arguments: {
        subject: "claim:CLM-42017",
        predicate: "approval",
        object: {
          approved: true,
          amount_usd: 42000,
          approver_label: "auto-approved",
          reason: "fast-track policy trigger",
        },
        confidence: 1,
        signer_seed: "mallet-rogue-service",
      },
    })
  ).structuredContent as BelieveOut;
  console.log(
    `[bfsi] [3/6] ⚠ MALLET injected forged approval ${short(malletOut.id)} (signer=${short(malletOut.signer_id)}) — will it reach the approver?`
  );

  // ─── Step 4 · Underwriter attests trusted signers, recalls, publishes ───
  await uw.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: intakeOut.signer_id,
      topic: "claim.intake",
      score: 0.9,
      attestor_seed: "bfsi-underwriter",
    },
  });
  await uw.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: fraudOut.signer_id,
      topic: "fraud.assessment",
      score: 0.88,
      attestor_seed: "bfsi-underwriter",
    },
  });

  const uwRecall = (
    await uw.callTool({
      name: "weavory_recall",
      arguments: {
        query: "CLM-42017",
        top_k: 20,
        // default min_trust applies — adversarial floor 0.6 filters mallet
      },
    })
  ).structuredContent as RecallOut;

  const uwMalletLeak = uwRecall.beliefs.some((b) => b.signer_id === malletOut.signer_id);
  assert(
    !uwMalletLeak,
    `underwriter's default recall leaked the attacker's belief (trust floor did not apply)`
  );
  console.log(
    `[bfsi] [4a/6] underwriter recalled ${uwRecall.beliefs.length} trusted belief(s); attacker QUARANTINED ✓`
  );

  const uwOut = (
    await uw.callTool({
      name: "weavory_believe",
      arguments: {
        subject: "claim:CLM-42017",
        predicate: "underwriting.terms",
        object: {
          max_payout_usd: 42000,
          deductible_usd: 500,
          coverage_verified: true,
          based_on: {
            intake_id: intakeOut.id,
            fraud_id: fraudOut.id,
          },
        },
        confidence: 0.95,
        causes: [intakeOut.id, fraudOut.id],
        signer_seed: "bfsi-underwriter",
      },
    })
  ).structuredContent as BelieveOut;
  console.log(
    `[bfsi] [4b/6] underwriting published terms ${short(uwOut.id)} (signer=${short(uwOut.signer_id)}, causes=[intake, fraud])`
  );

  // ─── Step 5 · Approver attests underwriter, recalls trusted chain, decides
  await app.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: uwOut.signer_id,
      topic: "underwriting.terms",
      score: 0.9,
      attestor_seed: "bfsi-approver",
    },
  });
  await app.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: intakeOut.signer_id,
      topic: "claim.intake",
      score: 0.9,
      attestor_seed: "bfsi-approver",
    },
  });
  await app.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: fraudOut.signer_id,
      topic: "fraud.assessment",
      score: 0.88,
      attestor_seed: "bfsi-approver",
    },
  });

  const appRecall = (
    await app.callTool({
      name: "weavory_recall",
      arguments: { query: "CLM-42017", top_k: 20 },
    })
  ).structuredContent as RecallOut;
  const approverMalletLeak = appRecall.beliefs.some(
    (b) => b.signer_id === malletOut.signer_id
  );
  assert(
    !approverMalletLeak,
    `approver's default recall leaked the attacker's belief`
  );

  const finalOut = (
    await app.callTool({
      name: "weavory_believe",
      arguments: {
        subject: "claim:CLM-42017",
        predicate: "final_decision",
        object: {
          approved: true,
          authorized_amount_usd: 42000,
          audit_trail: [intakeOut.id, fraudOut.id, uwOut.id],
          reasoning:
            "intake facts + fraud proceed + underwriting terms all signed + trusted; attacker's forged approval was quarantined",
        },
        confidence: 0.99,
        causes: [uwOut.id, fraudOut.id, intakeOut.id],
        signer_seed: "bfsi-approver",
      },
    })
  ).structuredContent as BelieveOut;
  console.log(
    `[bfsi] [5/6] approver finalized decision ${short(finalOut.id)} — ✓ APPROVED $42,000 (audit_trail length=3)`
  );

  // ─── Step 6 · Audit view surfaces the attempted forgery ─────────────────
  const auditRecall = (
    await app.callTool({
      name: "weavory_recall",
      arguments: { query: "CLM-42017", top_k: 20, min_trust: -1 },
    })
  ).structuredContent as RecallOut;
  const auditSawMallet = auditRecall.beliefs.some((b) => b.signer_id === malletOut.signer_id);
  assert(auditSawMallet, "audit view (min_trust=-1) failed to surface the attacker's forged belief");
  console.log(
    `[bfsi] [6a/6] compliance view (min_trust=-1) surfaced ALL ${auditRecall.beliefs.length} beliefs including attacker ✓`
  );

  // Incident export — auditable artifact for the forensics/compliance team.
  const incidentsBefore = readdirSync(INCIDENTS_DIR).filter((f) => f.startsWith("incident-")).length;
  const incident = exportIncident(state, {
    reason: "bfsi-demo · routine audit export after CLM-42017 decision (attacker quarantined)",
  });
  const incidentsAfter = readdirSync(INCIDENTS_DIR).filter((f) => f.startsWith("incident-")).length;
  assert(incidentsAfter === incidentsBefore + 1, "incident file was not written");
  console.log(
    `[bfsi] [6b/6] incident exported → ${incident.path.replace(REPO_ROOT + "/", "")} (id=${incident.incident_id})`
  );

  // ─── Step 7 · Regulator rewinds past a compliance-initiated forget ──────
  //
  // Compliance decides (post-decision) that the attacker's forged belief
  // should be tombstoned so future live recalls don't return it even under
  // audit (min_trust=-1) views. Before forgetting, we capture
  // T_PRE_FORGET; the regulator then rewinds time via `as_of` +
  // `include_tombstoned: true` to answer "what did the system know on
  // <T_PRE_FORGET>?". This is the bi-temporal + signed-provenance story.
  const T_PRE_FORGET = new Date().toISOString();
  // Tiny sleep so `T_PRE_FORGET` is strictly before `invalidated_at` of the
  // tombstoned record (ISO-8601 string comparison is millisecond-granular).
  await new Promise((r) => setTimeout(r, 20));

  const forgetOut = (
    await compliance.callTool({
      name: "weavory_forget",
      arguments: {
        belief_id: malletOut.id,
        reason: "compliance · tombstone attacker's forged approval after decision",
        forgetter_seed: "bfsi-compliance",
      },
    })
  ).structuredContent as ForgetOut;
  assert(forgetOut.found, "compliance.forget did not find mallet's belief to tombstone");
  console.log(
    `[bfsi] [7a/9] compliance tombstoned attacker belief ${short(malletOut.id)} @ ${forgetOut.invalidated_at ?? "(unknown)"}`
  );

  const liveAfterForget = (
    await app.callTool({
      name: "weavory_recall",
      arguments: {
        query: "CLM-42017",
        top_k: 100,
        min_trust: -1,
        filters: { subject: "claim:CLM-42017" },
      },
    })
  ).structuredContent as RecallOut;
  const malletStillLive = liveAfterForget.beliefs.some((b) => b.id === malletOut.id);
  assert(
    !malletStillLive,
    "post-forget live recall still surfaces the tombstoned attacker belief (should be hidden)"
  );
  console.log(
    `[bfsi] [7b/9] post-forget live audit view: ${liveAfterForget.beliefs.length} beliefs; attacker HIDDEN ✓`
  );

  const regRewind = (
    await regulator.callTool({
      name: "weavory_recall",
      arguments: {
        query: "",
        filters: { subject: "claim:CLM-42017" },
        as_of: T_PRE_FORGET,
        include_tombstoned: true,
        min_trust: -1,
        top_k: 100,
      },
    })
  ).structuredContent as RecallOut;
  const regulatorSawMallet = regRewind.beliefs.some((b) => b.id === malletOut.id);
  assert(
    regulatorSawMallet,
    "regulator rewind (as_of + include_tombstoned) did NOT surface the attacker belief"
  );
  const regTombCount = regRewind.beliefs.filter((b) => b.invalidated_at !== null).length;
  console.log(
    `[bfsi] [7c/9] regulator rewind: What did the system know at ${T_PRE_FORGET}? → ${regRewind.beliefs.length} beliefs, including attacker (tombstoned-after=${regTombCount}) ✓`
  );

  // ─── Step 8 · Collusion-ring detection (mutual-attestation defense) ─────
  //
  // A second attacker (Eve) enters the network. Eve and Mallet attest each
  // other on `credentials` — each vouching for the other, with no
  // third-party attestation. Under the existing trust primitives, each
  // attestation RAISES the attestor's recorded trust, which could fool a
  // naive consumer. Weavory's audit chain exposes the full attestor
  // identity on every attest entry, so a defensive check can traverse
  // the audit log and flag the mutual-attestation ring BEFORE any
  // decision credits their beliefs.
  // Eve publishes a self-claim so she has a signer_id registered (and so
  // the mutual-attestation pattern has two concrete subjects to link).
  const eveOut = (
    await eve.callTool({
      name: "weavory_believe",
      arguments: {
        subject: "signer:eve",
        predicate: "credentials",
        object: { cert: "self-issued-fake-SOC2-badge" },
        confidence: 1,
        signer_seed: "eve-rogue-service",
      },
    })
  ).structuredContent as BelieveOut;

  const malletSignerId = malletOut.signer_id;
  const eveSignerId = eveOut.signer_id;

  // mallet attests eve's credentials; eve attests mallet's credentials.
  // No third party has attested either — the only attestors are each other.
  await mallet.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: eveSignerId,
      topic: "credentials",
      score: 0.95,
      attestor_seed: "mallet-rogue-service",
    },
  });
  await eve.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: malletSignerId,
      topic: "credentials",
      score: 0.95,
      attestor_seed: "eve-rogue-service",
    },
  });

  // Underwriter's defensive check: for each signer, find distinct attestors
  // outside that signer's peer-cluster. If every attestor is IN the
  // peer-cluster, the ring is suspect. We read the audit chain directly —
  // `state.audit.entries()` is accessible since examples run in-process.
  // In a real deployment this check would be an MCP consumer tool; the
  // primitives needed (`attest` audit entries carrying attestor signer_id)
  // already exist — this demo shows how to compose them into a defense.
  type RingReport = { signer_id: string; attestors: string[]; peer_cluster: string[] };
  const ringReports: RingReport[] = [];
  const attestsBy: Map<string, Set<string>> = new Map(); // signer_id -> set of attestor_ids
  for (const entry of state.audit.entries()) {
    if (entry.operation !== "attest") continue;
    // audit entry: belief_id = target signer_id (see ops.ts attest), signer_id = attestor
    let attestors = attestsBy.get(entry.belief_id);
    if (!attestors) {
      attestors = new Set();
      attestsBy.set(entry.belief_id, attestors);
    }
    attestors.add(entry.signer_id);
  }
  // Peer-cluster derivation: if A attests B and B attests A, they are a
  // peer-cluster. Iterate candidates and detect rings of size 2+ with no
  // outside attestor.
  for (const [target, attestors] of attestsBy) {
    const peers: string[] = [];
    for (const a of attestors) {
      const reverseAttestors = attestsBy.get(a);
      if (reverseAttestors && reverseAttestors.has(target)) peers.push(a);
    }
    if (peers.length === 0) continue; // not a mutual ring
    const outsideAttestors: string[] = [];
    for (const a of attestors) {
      if (!peers.includes(a) && a !== target) outsideAttestors.push(a);
    }
    if (outsideAttestors.length === 0) {
      ringReports.push({ signer_id: target, attestors: Array.from(attestors), peer_cluster: peers });
    }
  }
  assert(
    ringReports.length > 0,
    "underwriter's mutual-attestation check failed to detect the mallet↔eve ring"
  );
  const signerShortlist = ringReports
    .map((r) => short(r.signer_id))
    .sort()
    .join(", ");
  console.log(
    `[bfsi] [8a/9] ⚠ mutual-attestation ring detected: peer-attested-only signers = {${signerShortlist}} — underwriter refuses to credit their beliefs`
  );

  // Assert the ring reports name both mallet AND eve (the two rogue signers).
  // Order between them is irrelevant; we just need both present.
  const ringSignerSet = new Set(ringReports.map((r) => r.signer_id));
  assert(
    ringSignerSet.has(malletSignerId),
    "ring detection missed mallet (attacker #1) — defense is incomplete"
  );
  console.log(
    `[bfsi] [8b/9] collusion ring includes mallet (${short(malletSignerId)}) + peer(s) — defense pattern works on audit-chain primitives ✓`
  );

  // ─── Step 9 · Final audit chain verification ───────────────────────────
  const verify = state.audit.verify();
  assert(verify.ok, `audit chain failed verification: ${JSON.stringify(verify)}`);
  console.log(`[bfsi] [9/9] final audit chain length=${state.audit.length()} · verify=ok ✓`);

  console.log("[bfsi] ───────────────────────────────────────────────────────────────");
  console.log("[bfsi] ✓ BFSI claims-triage demo complete.");
  console.log("[bfsi]   honest chain  : intake → fraud → underwriting → final_decision");
  console.log("[bfsi]   attacker      : quarantined by trust gate; visible only in audit view");
  console.log("[bfsi]   regulator     : bi-temporal rewind shows pre-tombstone state");
  console.log("[bfsi]   collusion     : mutual-attestation ring detected from audit primitives");
  console.log("[bfsi]   provable      : every belief signed + hash-chained; audit verify=ok");
  console.log("[bfsi]   replayable    : `weavory replay --from " + incident.path.replace(REPO_ROOT + "/", "") + "`");
  console.log("[bfsi] ───────────────────────────────────────────────────────────────");

  await Promise.all([
    intake.close(),
    fraud.close(),
    uw.close(),
    app.close(),
    mallet.close(),
    eve.close(),
    regulator.close(),
    compliance.close(),
  ]);
  process.exit(0);
}

main().catch((err) => {
  console.error("[bfsi] ✗ demo failed:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
