/**
 * examples/throne_integration.ts — Phase G.6 · The Throne
 *
 * ONE weavory instance + ONE MCP connection drives ALL four Phase-G arena
 * features simultaneously:
 *
 *   COMMONS  — subscribe + queue drain + consensus merge pick the honest winner
 *   WALL     — adversarial mode + trust gate filter the attacker's belief
 *   GAUNTLET — cloneState branch diverges from main; incident exported
 *   BAZAAR   — four-stage escrow (offer → payment → delivered → settled)
 *
 * All four arenas operate against the SAME EngineState without interference,
 * proving they compose rather than merely existing as isolated demos.
 *
 * On success the script prints a line:
 *
 *   [throne] ✓ Gate Throne integration passed · commons=<N> wall=<bool>
 *     gauntlet=<bool> bazaar=<bool>
 *
 * which `scripts/verify/gate_throne.sh` greps together with the per-arena
 * markers (── COMMONS ── etc.).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { cloneState } from "../src/engine/branch.js";
import { exportIncident, scanForTamper } from "../src/engine/incident.js";
import {
  CAPABILITY_OFFERS_PREDICATE,
  ESCROW_DELIVERED_PREDICATE,
  ESCROW_PAYMENT_PREDICATE,
  ESCROW_SETTLED_PREDICATE,
  escrowStatus,
  isEscrowSettled,
} from "../src/engine/bazaar.js";
import type { StoredBelief } from "../src/core/schema.js";
import type { ReputationSummary, ConflictGroup as _CG } from "../src/engine/bazaar.js";
import type { ConflictGroup } from "../src/engine/merge.js";

type BelieveOut = { id: string; signer_id: string };
type SubscribeOut = { subscription_id: string };
type RecallOut = {
  beliefs: StoredBelief[];
  total_matched: number;
  delivered_count?: number;
  dropped_count?: number;
  conflicts?: ConflictGroup[];
  merge_strategy?: "lww" | "consensus";
  reputation?: ReputationSummary;
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[throne] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

function short(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

async function main(): Promise<void> {
  console.log("[throne] starting throne_integration demo");
  console.log(
    "[throne] one EngineState, one MCP client, four arenas simultaneously"
  );

  // Adversarial mode ON — exercises the Wall's stricter trust floor while
  // the other arenas still work cleanly.
  const { server, state } = createServer(undefined, {
    runtimeWriter: false,
    adversarialMode: true,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "throne", version: "1.0.0" });
  await client.connect(clientT);

  // ---------------- COMMONS ----------------
  console.log("\n[throne] ── COMMONS ──");
  // Bob subscribes FIRST so queue captures everything.
  const sub = (
    await client.callTool({
      name: "weavory.subscribe",
      arguments: { pattern: "market:", signer_seed: "bob", queue_cap: 100 },
    })
  ).structuredContent as SubscribeOut;
  console.log(`[throne] bob subscribed to "market:" · ${sub.subscription_id}`);

  // Alice (trusted) and mallet (untrusted) both publish BTC price.
  const alicePub = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "market:BTC",
        predicate: "price",
        object: { usd: 50000, source: "honest-feed" },
        signer_seed: "alice",
      },
    })
  ).structuredContent as BelieveOut;
  const malletPub = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "market:BTC",
        predicate: "price",
        object: { usd: 10, source: "pump-attack" },
        signer_seed: "mallet",
      },
    })
  ).structuredContent as BelieveOut;
  // ETH via alice too — purely to grow the queue.
  await client.callTool({
    name: "weavory.believe",
    arguments: {
      subject: "market:ETH",
      predicate: "price",
      object: { usd: 3000, source: "honest-feed" },
      signer_seed: "alice",
    },
  });

  // Attestations: operator raises alice high, drops mallet low.
  await client.callTool({
    name: "weavory.attest",
    arguments: { signer_id: alicePub.signer_id, topic: "price", score: 0.9, attestor_seed: "operator" },
  });
  await client.callTool({
    name: "weavory.attest",
    arguments: { signer_id: malletPub.signer_id, topic: "price", score: -0.9, attestor_seed: "operator" },
  });

  // Drain the subscription queue via recall. min_trust=-1 so the drain
  // sees the queue content regardless of trust, matching W-0110 semantics.
  const drain = (
    await client.callTool({
      name: "weavory.recall",
      arguments: {
        query: "",
        subscription_id: sub.subscription_id,
        top_k: 100,
        min_trust: -1,
      },
    })
  ).structuredContent as RecallOut;
  console.log(
    `[throne] bob drained subscription: delivered=${drain.delivered_count} dropped=${drain.dropped_count}`
  );
  assert(
    (drain.delivered_count ?? 0) === 3,
    `commons drain should deliver 3 (got ${drain.delivered_count})`
  );

  // Consensus merge on the market:BTC conflict should pick alice's 50000.
  const consensus = (
    await client.callTool({
      name: "weavory.recall",
      arguments: {
        query: "BTC",
        top_k: 10,
        merge_strategy: "consensus",
        min_trust: -1,
      },
    })
  ).structuredContent as RecallOut;
  assert(
    consensus.beliefs.length === 1,
    "consensus should collapse to 1 BTC winner"
  );
  const btcWinner = consensus.beliefs[0];
  const btcUsd = (btcWinner.object as { usd: number }).usd;
  assert(btcUsd === 50000, `BTC consensus winner should be 50000 (got ${btcUsd})`);
  console.log(
    `[throne] consensus winner BTC=$${btcUsd} (alice trust > mallet trust)`
  );
  const commonsDelivered = drain.delivered_count ?? 0;

  // ---------------- WALL ----------------
  console.log("\n[throne] ── WALL ──");
  // Default recall (NO min_trust override) under adversarialMode=true
  // should filter mallet but keep alice.
  const defaultRecall = (
    await client.callTool({
      name: "weavory.recall",
      arguments: { query: "BTC", top_k: 10 },
    })
  ).structuredContent as RecallOut;
  const defaultIds = defaultRecall.beliefs.map((b) => b.id);
  const mallerVisible = defaultIds.includes(malletPub.id);
  const aliceVisible = defaultIds.includes(alicePub.id);
  console.log(
    `[throne] default recall (adversarial): alice_visible=${aliceVisible} mallet_visible=${mallerVisible}`
  );
  assert(aliceVisible, "alice's belief must pass the Wall's trust gate");
  assert(!mallerVisible, "mallet's belief must be filtered by the Wall's trust gate");
  const wallFiltered = !mallerVisible && aliceVisible;

  // Tamper scan — clean (no audit mutation in this demo).
  const tamper = scanForTamper(state);
  assert(tamper.ok, "tamper scan should be clean on the main chain");
  console.log(`[throne] tamper scan: ok (chain length ${tamper.length})`);

  // ---------------- GAUNTLET ----------------
  console.log("\n[throne] ── GAUNTLET ──");
  const branchState = cloneState(state);
  const branch = createServer(branchState, { runtimeWriter: false });
  const [bT, bS] = InMemoryTransport.createLinkedPair();
  await branch.server.connect(bS);
  const branchClient = new Client({ name: "throne-branch", version: "1.0.0" });
  await branchClient.connect(bT);
  console.log("[throne] branch snapshot cloned from main");

  // Divergence: on branch, alice posts a crash ($30,000); on main, alice posts a pump ($60,000).
  await client.callTool({
    name: "weavory.believe",
    arguments: {
      subject: "market:BTC",
      predicate: "price",
      object: { usd: 60000, source: "honest-feed" },
      signer_seed: "alice",
    },
  });
  await branchClient.callTool({
    name: "weavory.believe",
    arguments: {
      subject: "market:BTC",
      predicate: "price",
      object: { usd: 30000, source: "honest-feed" },
      signer_seed: "alice",
    },
  });

  const mainBtc = (
    await client.callTool({
      name: "weavory.recall",
      arguments: { query: "BTC", top_k: 20 },
    })
  ).structuredContent as RecallOut;
  const branchBtc = (
    await branchClient.callTool({
      name: "weavory.recall",
      arguments: { query: "BTC", top_k: 20 },
    })
  ).structuredContent as RecallOut;
  const mainPrices = mainBtc.beliefs.map((b) => (b.object as { usd: number }).usd).sort();
  const branchPrices = branchBtc.beliefs
    .map((b) => (b.object as { usd: number }).usd)
    .sort();
  console.log(
    `[throne] main BTC prices: ${JSON.stringify(mainPrices)} · branch BTC prices: ${JSON.stringify(branchPrices)}`
  );
  const mainHas60k = mainPrices.includes(60000);
  const mainLacks30k = !mainPrices.includes(30000);
  const branchHas30k = branchPrices.includes(30000);
  const branchLacks60k = !branchPrices.includes(60000);
  assert(mainHas60k, "main should include BTC=$60000");
  assert(mainLacks30k, "main should NOT include BTC=$30000 (that's the branch)");
  assert(branchHas30k, "branch should include BTC=$30000");
  assert(branchLacks60k, "branch should NOT include BTC=$60000 (that's main)");
  const gauntletDiverged = mainHas60k && mainLacks30k && branchHas30k && branchLacks60k;

  // Export an incident from main.
  const { path: incidentPath, incident_id } = exportIncident(state, {
    reason: "throne_integration drill",
  });
  console.log(`[throne] incident exported: ${incident_id}`);
  console.log(`[throne] incident_path=${incidentPath}`);

  // ---------------- BAZAAR ----------------
  console.log("\n[throne] ── BAZAAR ──");
  const offer = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "agent:alice",
        predicate: CAPABILITY_OFFERS_PREDICATE,
        object: { name: "summarize_paragraph", price: 5, escrow_required: true },
        signer_seed: "alice",
      },
    })
  ).structuredContent as BelieveOut;
  // operator boosts alice's reputation on the capability topic to clear the adversarial 0.6 gate.
  await client.callTool({
    name: "weavory.attest",
    arguments: {
      signer_id: offer.signer_id,
      topic: "summarize_paragraph",
      score: 0.9,
      attestor_seed: "operator",
    },
  });
  await client.callTool({
    name: "weavory.attest",
    arguments: {
      signer_id: offer.signer_id,
      topic: "capability.offers",
      score: 0.9,
      attestor_seed: "operator",
    },
  });

  // Bob discovers and checks reputation.
  const discovery = (
    await client.callTool({
      name: "weavory.recall",
      arguments: {
        query: "summarize",
        top_k: 5,
        filters: { predicate: CAPABILITY_OFFERS_PREDICATE },
      },
    })
  ).structuredContent as RecallOut;
  assert(
    discovery.beliefs.some((b) => b.id === offer.id),
    "bazaar discovery must see alice's offer"
  );
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
  assert(rep !== undefined, "recall should attach reputation");
  console.log(
    `[throne] bob reputation check: alice avg_trust=${rep!.avg_trust.toFixed(2)} attestations=${rep!.attestation_count}`
  );

  // Four-stage escrow.
  const payment = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "agent:bob",
        predicate: ESCROW_PAYMENT_PREDICATE,
        object: { offer_id: offer.id, amount: 5 },
        signer_seed: "bob",
        causes: [offer.id],
      },
    })
  ).structuredContent as BelieveOut;
  const delivered = (
    await client.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "agent:alice",
        predicate: ESCROW_DELIVERED_PREDICATE,
        object: { payment_id: payment.id, result: "ok" },
        signer_seed: "alice",
        causes: [payment.id],
      },
    })
  ).structuredContent as BelieveOut;
  await client.callTool({
    name: "weavory.believe",
    arguments: {
      subject: "agent:bob",
      predicate: ESCROW_SETTLED_PREDICATE,
      object: { delivery_id: delivered.id, outcome: "accepted" },
      signer_seed: "bob",
      causes: [delivered.id],
    },
  });

  const status = escrowStatus(state, offer.id);
  const stages = status.steps.map((s) => s.stage).join(",");
  console.log(`[throne] escrow thread: ${stages}`);
  assert(
    stages === "offer,payment,delivered,settled",
    `expected four-stage chain, got ${stages}`
  );
  const bazaarSettled = isEscrowSettled(state, offer.id);
  assert(bazaarSettled, "bazaar escrow must settle with outcome=accepted");
  console.log(`[throne] isEscrowSettled=${bazaarSettled} outcome=${status.outcome}`);

  // ---------------- INTEGRATION ----------------
  console.log("\n[throne] ── INTEGRATION ──");
  // Audit chain still clean after all four arenas banged on the same state.
  const finalTamper = scanForTamper(state);
  assert(finalTamper.ok, "audit chain must still verify after all arenas");
  console.log(
    `[throne] final chain length=${finalTamper.length} · verify=ok`
  );

  console.log(
    `\n[throne] ✓ Gate Throne integration passed · commons=${commonsDelivered} wall=${wallFiltered} gauntlet=${gauntletDiverged} bazaar=${bazaarSettled}`
  );
}

main().catch((err) => {
  console.error("[throne] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
