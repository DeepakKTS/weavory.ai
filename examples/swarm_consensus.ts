/**
 * examples/swarm_consensus.ts — subscription queue + consensus merge
 *
 * Exercises two new G.2 capabilities end-to-end over the MCP surface:
 *   1. Subscription match queue + recall drain (W-0110).
 *   2. Opt-in consensus merge + conflict visibility (W-0111).
 *
 * Scenario (shared subject `sensor:cambridge`, predicate `reading`):
 *   - alice  (trust 0.9 on "reading") publishes X = 42
 *   - bob    (trust 0.9 on "reading") publishes X = 42  ← agrees with alice
 *   - mallet (trust 0.1 on "reading") publishes X = 0   ← disagrees
 *   - wally  subscribes to "sensor:cambridge" BEFORE any publishes.
 *
 * Asserts:
 *   - wally's drain returns exactly 3 queued beliefs in order.
 *   - recall with include_conflicts=true shows 1 conflict group with 3 variants.
 *   - recall with merge_strategy=consensus collapses to a single winner whose
 *     object.X === 42 (alice+bob outvote mallet by trust weight).
 *   - recall with merge_strategy=lww picks the last-recorded belief (mallet)
 *     regardless of trust — proves strategies are orthogonal to trust.
 *
 * Exit 0 on success; process.exit(1) on any assertion failure. Used by
 * scripts/verify/gate_swarm.sh.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import type { StoredBelief } from "../src/core/schema.js";
import type { ConflictGroup } from "../src/engine/merge.js";

type BelieveOut = { id: string; signer_id: string };
type SubscribeOut = { subscription_id: string; queue_cap: number };
type RecallOut = {
  beliefs: StoredBelief[];
  total_matched: number;
  delivered_count?: number;
  dropped_count?: number;
  conflicts?: ConflictGroup[];
  merge_strategy?: "lww" | "consensus";
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[swarm] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

function shortId(s: string, n = 12): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function main(): Promise<void> {
  console.log("[swarm] starting swarm_consensus demo");

  // Shared engine state so alice/bob/mallet/wally all reach the same weavory.
  const { server, state } = createServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);

  const client = new Client({ name: "swarm-consensus", version: "1.0.0" });
  await client.connect(clientT);
  console.log("[swarm] one MCP client connected to shared weavory");

  // 1. Wally subscribes FIRST so the queue captures all subsequent publishes.
  const sub = (
    await client.callTool({
      name: "weavory_subscribe",
      arguments: { pattern: "sensor:cambridge", signer_seed: "wally", queue_cap: 100 },
    })
  ).structuredContent as SubscribeOut;
  console.log(`[swarm] wally subscribed: ${sub.subscription_id} (cap=${sub.queue_cap})`);

  // 2. Alice, Bob, Mallet all publish — same subject+predicate, different objects.
  const publish = async (seed: string, x: number): Promise<BelieveOut> =>
    (
      await client.callTool({
        name: "weavory_believe",
        arguments: {
          subject: "sensor:cambridge",
          predicate: "reading",
          object: { X: x, signal_source: "field-sensor-7" },
          signer_seed: seed,
        },
      })
    ).structuredContent as BelieveOut;

  const a = await publish("alice", 42);
  const b = await publish("bob", 42);
  // Sleep so mallet's recorded_at is strictly later (deterministic lww).
  await new Promise((r) => setTimeout(r, 10));
  const m = await publish("mallet", 0);
  console.log(
    `[swarm] published 3 beliefs: alice=${shortId(a.id)} bob=${shortId(b.id)} mallet=${shortId(m.id)}`
  );

  // 3. Trust attestations — wally trusts alice + bob highly, mallet little.
  const attest = async (signerId: string, score: number): Promise<void> => {
    await client.callTool({
      name: "weavory_attest",
      arguments: { signer_id: signerId, topic: "reading", score, attestor_seed: "wally" },
    });
  };
  await attest(a.signer_id, 0.9);
  await attest(b.signer_id, 0.9);
  await attest(m.signer_id, 0.1);
  console.log("[swarm] wally attested: alice=+0.9, bob=+0.9, mallet=+0.1");

  // 4. Drain the subscription queue.
  const drained = (
    await client.callTool({
      name: "weavory_recall",
      arguments: {
        query: "",
        subscription_id: sub.subscription_id,
        top_k: 100,
        min_trust: -1, // include everything so we see the drain, not the trust gate
      },
    })
  ).structuredContent as RecallOut;
  console.log(
    `[swarm] subscription drain: delivered=${drained.delivered_count} dropped=${drained.dropped_count}`
  );
  assert(
    drained.delivered_count === 3,
    `subscription should have queued all 3 publishes (got ${drained.delivered_count})`
  );
  const drainedIds = drained.beliefs.map((x) => x.id);
  assert(drainedIds.includes(a.id), "alice's belief must be in the drain");
  assert(drainedIds.includes(b.id), "bob's belief must be in the drain");
  assert(drainedIds.includes(m.id), "mallet's belief must be in the drain");

  // 5. Recall with include_conflicts=true — exposes the conflict group.
  const withConflicts = (
    await client.callTool({
      name: "weavory_recall",
      arguments: { query: "sensor", top_k: 10, include_conflicts: true, min_trust: -1 },
    })
  ).structuredContent as RecallOut;
  assert(
    withConflicts.conflicts !== undefined && withConflicts.conflicts.length === 1,
    `expected exactly 1 conflict group (got ${withConflicts.conflicts?.length ?? "none"})`
  );
  const group = withConflicts.conflicts![0];
  assert(
    group.variants.length === 3,
    `conflict group should carry all 3 variants (got ${group.variants.length})`
  );
  console.log(
    `[swarm] include_conflicts=true: 1 group with ${group.variants.length} variants`
  );

  // 6. merge_strategy=consensus — trust-weighted winner should be 42 (alice+bob = 1.8 > mallet 0.1).
  const consensus = (
    await client.callTool({
      name: "weavory_recall",
      arguments: { query: "sensor", top_k: 10, merge_strategy: "consensus", min_trust: -1 },
    })
  ).structuredContent as RecallOut;
  assert(
    consensus.beliefs.length === 1,
    `consensus should collapse to 1 winner (got ${consensus.beliefs.length})`
  );
  const consensusWinner = consensus.beliefs[0];
  const winnerX = (consensusWinner.object as { X: number }).X;
  assert(winnerX === 42, `consensus winner.X should be 42 (got ${winnerX})`);
  console.log(`[swarm] merge_strategy=consensus → winner.X = ${winnerX} (alice+bob outvote mallet)`);

  // 7. merge_strategy=lww — latest recorded_at wins regardless of trust (mallet).
  const lww = (
    await client.callTool({
      name: "weavory_recall",
      arguments: { query: "sensor", top_k: 10, merge_strategy: "lww", min_trust: -1 },
    })
  ).structuredContent as RecallOut;
  assert(
    lww.beliefs.length === 1,
    `lww should collapse to 1 winner (got ${lww.beliefs.length})`
  );
  const lwwX = (lww.beliefs[0].object as { X: number }).X;
  assert(lwwX === 0, `lww winner.X should be 0 (mallet, latest) but got ${lwwX}`);
  console.log(`[swarm] merge_strategy=lww → winner.X = ${lwwX} (latest recorded_at)`);

  console.log("\n[swarm] ✓ Gate Swarm demo passed — queue drain + conflict merge both live.");
}

main().catch((err) => {
  console.error("[swarm] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
