/**
 * examples/temporal_rewind.ts — Gate 5 demo
 *
 * Bi-temporal recall: an agent can ask "what did we think was true at time T?"
 * independently of what is true now.
 *
 * Scenario:
 *   1. At t0, alice publishes congested=true.
 *   2. A moment later, captured as t_snapshot.
 *   3. Then alice forgets that belief.
 *   4. At t_now, live recall returns 0 matches (tombstoned).
 *   5. as_of=t_snapshot recall still returns the original belief.
 *
 * Gate-5 pass criterion: live total_matched == 0 AND past total_matched == 1.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import type { StoredBelief } from "../src/core/schema.js";

type BelieveOut = { id: string; signer_id: string };
type RecallOut = { beliefs: StoredBelief[]; total_matched: number };

async function main() {
  const { server, state } = createServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);

  const alice = new Client({ name: "alice", version: "1.0.0" });
  await alice.connect(clientT);
  console.log("[rewind] alice connected");

  // 1. Publish.
  const out = (await alice.callTool({
    name: "weavory_believe",
    arguments: {
      subject: "scenario:rewind",
      predicate: "observation",
      object: { congested: true, eta_delta_min: 14 },
      signer_seed: "alice",
    },
  })).structuredContent as BelieveOut;
  console.log(`[rewind] alice believed ${short(out.id)}`);

  // Self-attest so default trust gate lets us read back.
  await alice.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: out.signer_id,
      topic: "observation",
      score: 0.9,
      attestor_seed: "alice",
    },
  });

  // 2. Capture t_snapshot while the belief is live (use the server-side now()).
  const liveNow = (await alice.callTool({
    name: "weavory_recall",
    arguments: { query: "rewind", top_k: 1 },
  })).structuredContent as RecallOut;
  const t_snapshot = liveNow.now;
  console.log(`[rewind] captured t_snapshot = ${t_snapshot} (live matches: ${liveNow.total_matched})`);
  assert(liveNow.total_matched === 1, "belief should be live before forget");
  // Nudge the clock so subsequent events have strictly-later timestamps.
  await new Promise((r) => setTimeout(r, 10));

  // 3. Forget.
  await alice.callTool({
    name: "weavory_forget",
    arguments: { belief_id: out.id, forgetter_seed: "alice" },
  });
  console.log("[rewind] alice forgot the belief");

  // 4. Live recall — should be 0.
  const live = (await alice.callTool({
    name: "weavory_recall",
    arguments: { query: "rewind", top_k: 5 },
  })).structuredContent as RecallOut;
  console.log(`[rewind] live recall: ${live.total_matched} match(es)`);
  assert(live.total_matched === 0, "live recall must be empty after forget");

  // 5. as_of=t_snapshot — should be 1.
  const past = (await alice.callTool({
    name: "weavory_recall",
    arguments: { query: "rewind", top_k: 5, as_of: t_snapshot },
  })).structuredContent as RecallOut;
  console.log(`[rewind] past recall (as_of=${t_snapshot}): ${past.total_matched} match(es)`);
  assert(past.total_matched === 1, "past recall must still see the belief");

  const hit = past.beliefs[0];
  assert(hit.id === out.id, "past recall must return the original belief id");
  assert(hit.invalidated_at !== null, "stored belief must carry invalidated_at");
  console.log(`[rewind] past belief has invalidated_at=${hit.invalidated_at}`);

  console.log("\n[rewind] ✓ Gate 5 demo complete — bi-temporal as_of recall works as specified.");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[rewind] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

function short(s: string): string {
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}

main().catch((err) => {
  console.error("[rewind] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
