/**
 * examples/bazaar_trade.ts — Phase G.5 · The Bazaar
 *
 * End-to-end trade executed over MCP, exercising the three G.5 primitives:
 *
 *   W-0140 reputation aggregate — Bob queries alice's reputation via
 *          `recall(filters.reputation_of=alice.signer_id)` before spending.
 *   W-0141 capability ads     — Bob discovers alice's offer via
 *          `recall(filters.predicate="capability.offers")`.
 *   W-0142 lightweight escrow  — four beliefs linked by the existing
 *          `causes[]` chain: offer → payment → delivered → settled.
 *
 * Demo plot:
 *   1. Alice publishes a `capability.offers` belief: summarize_paragraph,
 *      $5 escrow.
 *   2. A marketplace operator "wally" attests alice on the topic
 *      "summarize_paragraph" with trust 0.9.
 *   3. Bob discovers the offer, looks up alice's reputation, confirms it
 *      meets his threshold.
 *   4. Bob publishes an `escrow.payment` belief (causes=[offer_id]).
 *   5. Alice publishes an `escrow.delivered` belief (causes=[payment_id]).
 *   6. Bob publishes an `escrow.settled` belief with outcome=accepted
 *      (causes=[delivery_id]).
 *
 * Asserts (exit 0 iff all pass):
 *   - offer discovered (1 match, name="summarize_paragraph")
 *   - reputation attached; avg_trust ≥ 0.85, beliefs_authored ≥ 2
 *   - thread has exactly 4 stages: offer, payment, delivered, settled
 *   - isEscrowSettled = true, outcome = "accepted"
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import {
  CAPABILITY_OFFERS_PREDICATE,
  ESCROW_DELIVERED_PREDICATE,
  ESCROW_PAYMENT_PREDICATE,
  ESCROW_SETTLED_PREDICATE,
  escrowStatus,
  isEscrowSettled,
} from "../src/engine/escrow.js";
import type { StoredBelief } from "../src/core/schema.js";
import type { ReputationSummary } from "../src/engine/escrow.js";

type BelieveOut = { id: string; signer_id: string };
type RecallOut = {
  beliefs: StoredBelief[];
  total_matched: number;
  reputation?: ReputationSummary;
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[bazaar] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

async function main(): Promise<void> {
  console.log("[bazaar] starting bazaar_trade demo");
  const { server, state } = createServer(undefined, { runtimeWriter: false });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client({ name: "bazaar-trade", version: "1.0.0" });
  await client.connect(cT);

  // --- Stage 1: Alice advertises ---
  const offer = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "agent:alice",
        predicate: CAPABILITY_OFFERS_PREDICATE,
        object: {
          name: "summarize_paragraph",
          price: 5,
          escrow_required: true,
          description: "I summarize a paragraph into one sentence.",
        },
        signer_seed: "alice",
      },
    })
  ).structuredContent as BelieveOut;
  console.log(`[bazaar] alice offered summarize_paragraph: offer_id=${shortId(offer.id)}`);

  // wally attests alice on the capability topic so her reputation is positive.
  await client.callTool({
    name: "weavory.attest",
    arguments: {
      signer_id: offer.signer_id,
      topic: "summarize_paragraph",
      score: 0.9,
      attestor_seed: "wally",
    },
  });
  // And on a generic "offerings" topic for a richer reputation profile.
  await client.callTool({
    name: "weavory.attest",
    arguments: {
      signer_id: offer.signer_id,
      topic: "offerings",
      score: 0.8,
      attestor_seed: "wally",
    },
  });

  // --- Stage 2: Bob discovers + checks reputation ---
  const discovery = (
    await client.callTool({
      name: "weavory.recall",
      arguments: {
        query: "summarize",
        top_k: 10,
        filters: { predicate: CAPABILITY_OFFERS_PREDICATE },
        min_trust: -1,
      },
    })
  ).structuredContent as RecallOut;
  assert(
    discovery.total_matched >= 1,
    `discovery should see at least 1 offer (got ${discovery.total_matched})`
  );
  const found = discovery.beliefs.find((b) => b.id === offer.id);
  assert(found !== undefined, "bob did not find alice's offer");
  const foundName = (found!.object as { name: string }).name;
  assert(foundName === "summarize_paragraph", `expected name 'summarize_paragraph', got ${foundName}`);
  console.log(`[bazaar] bob discovered offer: name=${foundName}`);

  const repCall = (
    await client.callTool({
      name: "weavory.recall",
      arguments: {
        query: "",
        top_k: 50,
        filters: { reputation_of: offer.signer_id },
        min_trust: -1,
      },
    })
  ).structuredContent as RecallOut;
  const rep = repCall.reputation;
  assert(rep !== undefined, "recall(filters.reputation_of) must attach reputation");
  assert(rep!.signer_id === offer.signer_id, "reputation.signer_id must match");
  assert(
    rep!.attestation_count >= 2,
    `reputation.attestation_count should be ≥ 2 (got ${rep!.attestation_count})`
  );
  assert(
    rep!.avg_trust >= 0.85,
    `reputation.avg_trust should be ≥ 0.85 (got ${rep!.avg_trust})`
  );
  assert(
    rep!.beliefs_authored >= 1,
    `reputation.beliefs_authored should be ≥ 1 (got ${rep!.beliefs_authored})`
  );
  console.log(
    `[bazaar] bob fetched alice's reputation: avg_trust=${rep!.avg_trust.toFixed(2)} attestations=${rep!.attestation_count} beliefs=${rep!.beliefs_authored}`
  );

  // --- Stage 3: Bob pays ---
  const payment = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "agent:bob",
        predicate: ESCROW_PAYMENT_PREDICATE,
        object: {
          offer_id: offer.id,
          amount: 5,
          currency: "WEAVE",
        },
        signer_seed: "bob",
        causes: [offer.id],
      },
    })
  ).structuredContent as BelieveOut;
  console.log(`[bazaar] bob paid 5 WEAVE: payment_id=${shortId(payment.id)}`);

  // --- Stage 4: Alice delivers ---
  const delivered = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "agent:alice",
        predicate: ESCROW_DELIVERED_PREDICATE,
        object: {
          payment_id: payment.id,
          result:
            "Weavory is the MCP-native shared-belief coordination layer for AI agent swarms.",
        },
        signer_seed: "alice",
        causes: [payment.id],
      },
    })
  ).structuredContent as BelieveOut;
  console.log(`[bazaar] alice delivered: delivery_id=${shortId(delivered.id)}`);

  // --- Stage 5: Bob settles ---
  const settled = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "agent:bob",
        predicate: ESCROW_SETTLED_PREDICATE,
        object: {
          delivery_id: delivered.id,
          outcome: "accepted",
        },
        signer_seed: "bob",
        causes: [delivered.id],
      },
    })
  ).structuredContent as BelieveOut;
  console.log(`[bazaar] bob settled: settlement_id=${shortId(settled.id)} outcome=accepted`);

  // --- Verify the full causal thread ---
  const status = escrowStatus(state, offer.id);
  assert(status.has_offer, "status.has_offer must be true");
  assert(status.has_payment, "status.has_payment must be true");
  assert(status.has_delivered, "status.has_delivered must be true");
  assert(status.has_settled, "status.has_settled must be true");
  assert(status.outcome === "accepted", `outcome should be 'accepted' (got ${status.outcome})`);
  assert(status.settled === true, "settled must be true");
  assert(isEscrowSettled(state, offer.id), "isEscrowSettled must return true");
  const stages = status.steps.map((s) => s.stage).join(",");
  assert(stages === "offer,payment,delivered,settled", `wrong stage order: ${stages}`);
  console.log(`[bazaar] escrow thread stages: ${stages}`);
  console.log(`[bazaar] isEscrowSettled = true, outcome = accepted`);

  console.log(
    "\n[bazaar] ✓ Gate Bazaar demo: discovery + reputation + four-stage escrow all verified."
  );
}

main().catch((err) => {
  console.error("[bazaar] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
