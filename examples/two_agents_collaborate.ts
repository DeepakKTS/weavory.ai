/**
 * examples/two_agents_collaborate.ts — Gate 3 demo
 *
 * Two independent MCP clients ("alice" and "bob") share one weavory server.
 *   1. Alice publishes a signed belief about a scenario.
 *   2. Bob attests Alice (raising trust on the topic).
 *   3. Bob recalls beliefs matching the scenario query.
 *   4. Bob verifies Alice's signature independently.
 *   5. Script exits 0 if the round-trip is consistent, non-zero otherwise.
 *
 * Run:
 *   pnpm tsx examples/two_agents_collaborate.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { verifyBelief } from "../src/core/sign.js";
import type { StoredBelief } from "../src/core/schema.js";

type BelieveOut = { id: string; signer_id: string; entry_hash: string; ingested_at: string; audit_length: number };
type RecallOut = { beliefs: StoredBelief[]; total_matched: number; now: string };
type AttestOut = { applied_score: number; attestor_id: string; entry_hash: string };

async function main() {
  // One weavory server, two independent MCP clients.
  const [aliceT, serverAT] = InMemoryTransport.createLinkedPair();
  const [bobT, serverBT] = InMemoryTransport.createLinkedPair();

  // Two server instances sharing ONE EngineState = the "shared weavory".
  // In production, a single server handles all connections over stdio/HTTP —
  // but for the demo, two paired transports to the same state is equivalent.
  const { server: serverA, state } = createServer();
  const { server: serverB } = createServer(state);

  await Promise.all([serverA.connect(serverAT), serverB.connect(serverBT)]);

  const alice = new Client({ name: "alice", version: "1.0.0" });
  const bob = new Client({ name: "bob", version: "1.0.0" });
  await Promise.all([alice.connect(aliceT), bob.connect(bobT)]);

  console.log("[demo] alice + bob connected");

  // Step 1: Alice publishes a belief about a scenario.
  const scenario = {
    subject: "scenario:traffic-cambridge",
    predicate: "observation",
    object: { congested: true, eta_delta_min: 14, signal_source: "field-sensor-7" },
    signer_seed: "alice",
  };
  const aliceBelieve = (await alice.callTool({ name: "weavory_believe", arguments: scenario }))
    .structuredContent as BelieveOut;
  console.log(`[demo] alice believed ${short(aliceBelieve.id)} (signer=${short(aliceBelieve.signer_id)})`);
  assert(/^[0-9a-f]{64}$/.test(aliceBelieve.id), "belief id must be 64 hex");
  assert(aliceBelieve.audit_length >= 1, "audit must grow");

  // Step 2: Bob attests Alice on the topic "observation" so the default trust gate lets through the recall.
  const attest = (await bob.callTool({
    name: "weavory_attest",
    arguments: {
      signer_id: aliceBelieve.signer_id,
      topic: "observation",
      score: 0.8,
      attestor_seed: "bob",
    },
  })).structuredContent as AttestOut;
  console.log(`[demo] bob attested alice @ 0.8 (entry=${short(attest.entry_hash)})`);
  assert(attest.applied_score === 0.8, "attestation score applied");

  // Step 3: Bob recalls the scenario.
  const recall = (await bob.callTool({
    name: "weavory_recall",
    arguments: { query: "traffic", top_k: 3 },
  })).structuredContent as RecallOut;
  console.log(`[demo] bob recalled ${recall.total_matched} belief(s)`);
  assert(recall.total_matched >= 1, "bob should see alice's belief");
  const hit = recall.beliefs.find((b) => b.id === aliceBelieve.id);
  assert(hit !== undefined, "alice's belief must be in bob's recall");

  // Step 4: Bob independently verifies Alice's signature.
  const vr = verifyBelief({
    id: hit!.id,
    signature: hit!.signature,
    schema_version: hit!.schema_version,
    subject: hit!.subject,
    predicate: hit!.predicate,
    object: hit!.object,
    confidence: hit!.confidence,
    valid_from: hit!.valid_from,
    valid_to: hit!.valid_to,
    recorded_at: hit!.recorded_at,
    signer_id: hit!.signer_id,
    causes: hit!.causes,
  });
  assert(vr.ok === true, "bob must be able to verify alice's signature independently");
  console.log("[demo] bob independently verified alice's signature ✓");

  // Step 5: Downstream answer — "is it congested?" — extracted from the belief.
  const obj = hit!.object as { congested: boolean; eta_delta_min: number };
  const answer = obj.congested
    ? `traffic in cambridge is congested (+${obj.eta_delta_min} min)`
    : "traffic in cambridge is clear";
  console.log("[demo] bob's answer:", answer);
  assert(
    answer === "traffic in cambridge is congested (+14 min)",
    "bob's answer must match the scripted expectation"
  );

  console.log("\n[demo] ✓ Gate 3 demo complete — two-agent exchange via weavory round-tripped cleanly.");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[demo] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

function short(s: string): string {
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}

main().catch((err) => {
  console.error("[demo] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
