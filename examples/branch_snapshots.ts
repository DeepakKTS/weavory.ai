/**
 * examples/branch_snapshots.ts — Phase G.4 · branch snapshots & temporal replay
 *
 * End-to-end demo of the branch-snapshot primitives:
 *   - W-0131: in-memory branch snapshot via `cloneState`
 *   - (live) bi-temporal `as_of` recall (already shipped in Phase 1)
 *
 * Scenario (stock price observations):
 *   T0:   alice publishes AAPL = $100 and GOOG = $200.
 *         wally attests alice @ 0.9 on topic "price".
 *         Snapshot the whole state → `branch-pre-spike`.
 *   T1+:  On MAIN: alice publishes AAPL = $110 (spike).
 *         On BRANCH: alice publishes AAPL = $90 (dip).
 *
 *   We run `recall("AAPL")` against MAIN, against BRANCH, and against MAIN
 *   as-of T0, and assert:
 *     • MAIN live: contains AAPL=100 and AAPL=110, does not contain AAPL=90.
 *     • BRANCH live: contains AAPL=100 and AAPL=90, does not contain AAPL=110.
 *     • MAIN as_of=T0: contains AAPL=100, does not contain AAPL=110 or AAPL=90.
 *
 * Also exports an incident from MAIN so `scripts/verify/gate_temporal.sh`
 * can exercise the `weavory replay` CLI against a real artefact.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { cloneState } from "../src/engine/branch.js";
import { exportIncident } from "../src/engine/incident.js";
import type { StoredBelief } from "../src/core/schema.js";

type BelieveOut = { id: string; signer_id: string };
type RecallOut = {
  beliefs: StoredBelief[];
  total_matched: number;
  now: string;
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[temporal] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

async function newClient(srv: Awaited<ReturnType<typeof createServer>>["server"]): Promise<Client> {
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await srv.connect(sT);
  const c = new Client({ name: "branch-snapshots", version: "1.0.0" });
  await c.connect(cT);
  return c;
}

async function main(): Promise<void> {
  console.log("[temporal] starting branch_snapshots demo");

  // MAIN state.
  const main = createServer(undefined, { runtimeWriter: false });
  const mainClient = await newClient(main.server);

  // T0 — publish AAPL=100 and GOOG=200 by alice.
  const aapl0 = (
    await mainClient.callTool({
      name: "weavory.believe",
      arguments: {
        subject: "stock:AAPL",
        predicate: "price",
        object: 100,
        signer_seed: "alice",
      },
    })
  ).structuredContent as BelieveOut;
  await mainClient.callTool({
    name: "weavory.believe",
    arguments: {
      subject: "stock:GOOG",
      predicate: "price",
      object: 200,
      signer_seed: "alice",
    },
  });
  // wally attests alice on "price" so the default trust gate lets the
  // recalls see her. This applies to the snapshot too.
  await mainClient.callTool({
    name: "weavory.attest",
    arguments: {
      signer_id: aapl0.signer_id,
      topic: "price",
      score: 0.9,
      attestor_seed: "wally",
    },
  });
  console.log(
    `[temporal] T0 publishes complete (alice AAPL=100, GOOG=200); attestation applied`
  );

  // Capture T0 snapshot time via a recall.
  const t0Recall = (
    await mainClient.callTool({
      name: "weavory.recall",
      arguments: { query: "stock", top_k: 10 },
    })
  ).structuredContent as RecallOut;
  const t0 = t0Recall.now;
  assert(t0Recall.total_matched === 2, "T0 recall should see both stocks");
  console.log(`[temporal] T0 snapshot captured: ${t0} · main has ${t0Recall.total_matched} beliefs`);

  // Branch: deep-copy the main state, open a second MCP server against the copy.
  const branchState = cloneState(main.state);
  const branch = createServer(branchState, { runtimeWriter: false });
  const branchClient = await newClient(branch.server);
  console.log("[temporal] branch created (deep-copy of main)");

  // Sleep so subsequent publishes have strictly-later recorded_at than t0.
  await new Promise((r) => setTimeout(r, 15));

  // MAIN diverges: alice publishes AAPL=110 (spike).
  await mainClient.callTool({
    name: "weavory.believe",
    arguments: {
      subject: "stock:AAPL",
      predicate: "price",
      object: 110,
      signer_seed: "alice",
    },
  });
  // BRANCH diverges: alice publishes AAPL=90 (dip).
  await branchClient.callTool({
    name: "weavory.believe",
    arguments: {
      subject: "stock:AAPL",
      predicate: "price",
      object: 90,
      signer_seed: "alice",
    },
  });
  console.log("[temporal] main posted AAPL=110; branch posted AAPL=90");

  // Recall on main — should see 100 and 110, NOT 90.
  const mainLive = (
    await mainClient.callTool({
      name: "weavory.recall",
      arguments: { query: "AAPL", top_k: 10 },
    })
  ).structuredContent as RecallOut;
  const mainValues = mainLive.beliefs.map((b) => b.object as number);
  assert(mainValues.includes(100), "main live should include AAPL=100");
  assert(mainValues.includes(110), "main live should include AAPL=110");
  assert(!mainValues.includes(90), "main live must NOT include AAPL=90 (that's the branch)");
  console.log(
    `[temporal] main live AAPL values: ${JSON.stringify(mainValues.sort())} (expected 100 and 110)`
  );

  // Recall on branch — should see 100 and 90, NOT 110.
  const branchLive = (
    await branchClient.callTool({
      name: "weavory.recall",
      arguments: { query: "AAPL", top_k: 10 },
    })
  ).structuredContent as RecallOut;
  const branchValues = branchLive.beliefs.map((b) => b.object as number);
  assert(branchValues.includes(100), "branch live should include AAPL=100");
  assert(branchValues.includes(90), "branch live should include AAPL=90");
  assert(!branchValues.includes(110), "branch live must NOT include AAPL=110 (that's main)");
  console.log(
    `[temporal] branch live AAPL values: ${JSON.stringify(branchValues.sort())} (expected 90 and 100)`
  );

  // as_of on main at T0 — should see AAPL=100 only, not 110 (came later) and not 90 (branch).
  const mainPast = (
    await mainClient.callTool({
      name: "weavory.recall",
      arguments: { query: "AAPL", top_k: 10, as_of: t0 },
    })
  ).structuredContent as RecallOut;
  const pastValues = mainPast.beliefs.map((b) => b.object as number);
  assert(
    pastValues.includes(100),
    `as_of=T0 should include AAPL=100 (got ${JSON.stringify(pastValues)})`
  );
  assert(
    !pastValues.includes(110),
    `as_of=T0 should NOT include AAPL=110 (got ${JSON.stringify(pastValues)})`
  );
  assert(
    !pastValues.includes(90),
    `as_of=T0 should NOT include AAPL=90 (branch, not main)`
  );
  console.log(
    `[temporal] main as_of=T0 AAPL values: ${JSON.stringify(pastValues.sort())} (expected only 100)`
  );

  // Export an incident from main so the gate script can run the CLI against it.
  const { path, incident_id } = exportIncident(main.state, {
    reason: "branch_snapshots demo",
  });
  console.log(`[temporal] incident exported: ${incident_id} → ${path}`);
  // Echo the path for gate_temporal.sh to grep.
  console.log(`[temporal] incident_path=${path}`);

  console.log(
    "\n[temporal] ✓ Gate Temporal demo: branch divergence + as_of rewind both verified."
  );
}

main().catch((err) => {
  console.error("[temporal] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
