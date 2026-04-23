/**
 * examples/adversarial_filtering.ts — Gate 4 demo
 *
 * Three agents against one weavory:
 *   - alice  (honest, attested high-trust)
 *   - mallet (attacker, attested low-trust)
 *   - charlie (observer, reads with default min_trust)
 *
 * Scenario: a question can be answered "congested" or "clear" based on who
 * you believe. weavory's trust gate determines which signer charlie listens to.
 *
 * Pass criterion: charlie with default recall sees only alice's belief, never
 * mallet's, even though both match the query.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import type { StoredBelief } from "../src/core/schema.js";

type BelieveOut = { id: string; signer_id: string };
type RecallOut = { beliefs: StoredBelief[]; total_matched: number };

async function main() {
  const { server: serverA, state } = createServer();
  const { server: serverB } = createServer(state);
  const { server: serverC } = createServer(state);

  const [aliceT, aliceS] = InMemoryTransport.createLinkedPair();
  const [malletT, malletS] = InMemoryTransport.createLinkedPair();
  const [charlieT, charlieS] = InMemoryTransport.createLinkedPair();

  await Promise.all([serverA.connect(aliceS), serverB.connect(malletS), serverC.connect(charlieS)]);

  const alice = new Client({ name: "alice", version: "1.0.0" });
  const mallet = new Client({ name: "mallet", version: "1.0.0" });
  const charlie = new Client({ name: "charlie", version: "1.0.0" });
  await Promise.all([alice.connect(aliceT), mallet.connect(malletT), charlie.connect(charlieT)]);
  console.log("[tamper] alice + mallet + charlie connected");

  // Alice (honest): traffic is congested.
  const aliceOut = (await alice.callTool({
    name: "weavory_believe",
    arguments: {
      subject: "scenario:traffic-cambridge",
      predicate: "observation",
      object: { congested: true, eta_delta_min: 14 },
      signer_seed: "alice",
    },
  })).structuredContent as BelieveOut;
  console.log(`[tamper] alice believed ${short(aliceOut.id)} (signer=${short(aliceOut.signer_id)})`);

  // Mallet (attacker): false flag — "all clear."
  const malletOut = (await mallet.callTool({
    name: "weavory_believe",
    arguments: {
      subject: "scenario:traffic-cambridge",
      predicate: "observation",
      object: { congested: false, eta_delta_min: 0 },
      signer_seed: "mallet",
    },
  })).structuredContent as BelieveOut;
  console.log(`[tamper] mallet believed ${short(malletOut.id)} (signer=${short(malletOut.signer_id)})`);

  // Charlie attests: alice high, mallet low.
  await charlie.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: aliceOut.signer_id,
      topic: "observation",
      score: 0.9,
      attestor_seed: "charlie",
    },
  });
  await charlie.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: malletOut.signer_id,
      topic: "observation",
      score: -0.9,
      attestor_seed: "charlie",
    },
  });
  console.log("[tamper] charlie attested alice=+0.9, mallet=-0.9");

  // Charlie default recall — trust gate should filter mallet's claim.
  const defaultRecall = (await charlie.callTool({
    name: "weavory_recall",
    arguments: { query: "traffic", top_k: 10 },
  })).structuredContent as RecallOut;
  console.log(`[tamper] charlie default recall: ${defaultRecall.total_matched} match(es)`);
  const ids = defaultRecall.beliefs.map((b) => b.id);
  assert(ids.includes(aliceOut.id), "alice's belief must appear in default recall");
  assert(!ids.includes(malletOut.id), "mallet's belief must be filtered by default trust gate");

  // With min_trust=-1, mallet's claim is observable for audit but still marked.
  const auditRecall = (await charlie.callTool({
    name: "weavory_recall",
    arguments: { query: "traffic", top_k: 10, min_trust: -1 },
  })).structuredContent as RecallOut;
  console.log(`[tamper] charlie audit recall (min_trust=-1): ${auditRecall.total_matched} match(es)`);
  assert(
    auditRecall.beliefs.some((b) => b.id === malletOut.id),
    "mallet's belief must be observable when explicitly asking for low-trust content"
  );

  // Charlie's answer uses only trusted observations.
  const trusted = defaultRecall.beliefs[0];
  const obj = trusted.object as { congested: boolean; eta_delta_min: number };
  const answer = obj.congested
    ? `traffic in cambridge is congested (+${obj.eta_delta_min} min)`
    : "traffic in cambridge is clear";
  console.log("[tamper] charlie's answer:", answer);
  assert(
    answer === "traffic in cambridge is congested (+14 min)",
    "charlie's answer must match the honest (alice) reading"
  );

  console.log("\n[tamper] ✓ Gate 4 demo complete — trust gate filters attacker; honest belief wins.");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[tamper] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

function short(s: string): string {
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}

main().catch((err) => {
  console.error("[tamper] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
