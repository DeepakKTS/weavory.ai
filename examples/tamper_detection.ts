/**
 * examples/tamper_detection.ts — Phase G.3 · tamper detection & adversarial drill
 *
 * End-to-end adversarial drill exercising W-0120, W-0121, W-0122 together:
 *
 *   1. Start weavory with a RuntimeWriter pointing at a scratch runtime.json
 *      and adversarial mode on (WEAVORY_ADVERSARIAL=1-equivalent).
 *   2. Publish a few honest beliefs over MCP.
 *   3. Attacker directly mutates an audit entry (bypassing the public API).
 *   4. scanForTamper detects the break, sets runtime.json.tamper_alarm,
 *      and returns the bad_index.
 *   5. exportIncident writes ops/data/incidents/incident-<ts>.json with
 *      verify.ok=false and every belief + trust vector captured.
 *   6. Demo asserts runtime.json has the alarm + the incident file exists
 *      on disk, then exits 0.
 *
 * Used by scripts/verify/gate_tamper.sh. The incidents directory is created
 * under the real ops/data/incidents (gitignored) so the dashboard can pick
 * the file up in future panels.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { RuntimeWriter } from "../src/engine/runtime_writer.js";
import { scanForTamper, exportIncident } from "../src/engine/incident.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME_PATH = resolve(REPO_ROOT, "ops/data/runtime.json");
const INCIDENTS_DIR = resolve(REPO_ROOT, "ops/data/incidents");

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("[tamper] ✗ assertion failed:", msg);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log("[tamper] starting tamper_detection demo (adversarial drill)");
  mkdirSync(INCIDENTS_DIR, { recursive: true });

  // Clean slate for this demo run: baseline incident count before.
  const incidentsBefore = readdirSync(INCIDENTS_DIR).filter((f) =>
    f.startsWith("incident-")
  ).length;

  // Start the MCP server with adversarial mode on. We run the RuntimeWriter
  // manually (bypassing the automatic one) so we control its exit handlers —
  // a second writer on the same state would be a double-attach we don't want.
  const { server, state } = createServer(undefined, {
    adversarialMode: true,
    runtimeWriter: false,
  });
  const writer = new RuntimeWriter(state, {
    outPath: RUNTIME_PATH,
    debounceMs: 0,
    disableExitHandlers: true,
  });
  writer.attach();
  console.log(`[tamper] server online (adversarialMode=${state.adversarialMode}) writer→${RUNTIME_PATH}`);

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "wall-drill", version: "1.0.0" });
  await client.connect(clientT);

  // Publish three honest beliefs so the audit chain has substance.
  for (const i of [1, 2, 3]) {
    await client.callTool({
      name: "weavory_believe",
      arguments: {
        subject: `sensor:wall:${i}`,
        predicate: "reading",
        object: { value: i * 10 },
        signer_seed: "alice",
      },
    });
  }
  writer.flushNow();
  assert(state.audit.length() === 3, "audit chain should have 3 entries after 3 believes");
  console.log("[tamper] honest chain length = 3 (pre-tamper)");

  // Pre-tamper scan — must be clean.
  const pre = scanForTamper(state, writer);
  assert(pre.ok === true, "pre-tamper scan must report ok");
  console.log("[tamper] pre-tamper scan: ok");

  // ATTACKER simulates a direct in-memory mutation to entry index 1 — flipping
  // the belief_id without recomputing the entry_hash. In production this
  // models a malicious actor with raw filesystem / memory access.
  state.audit._adversarialMutate(1, (e) => ({ ...e, belief_id: "0".repeat(64) }));
  console.log("[tamper] attacker mutated audit entry #1");

  // Post-tamper scan — alarm should fire.
  const post = scanForTamper(state, writer);
  assert(post.ok === false, "post-tamper scan must fail");
  assert(post.alarm !== null, "tamper alarm must be populated");
  assert(post.alarm?.bad_index === 1, "alarm should point at entry 1");
  console.log(
    `[tamper] post-tamper scan: bad_index=${post.alarm?.bad_index} reason=${post.alarm?.reason}`
  );
  writer.flushNow();

  // Runtime snapshot must reflect the alarm.
  const snap = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
  assert(
    snap.tamper_alarm !== null,
    "runtime.json.tamper_alarm must be populated after scan"
  );
  assert(
    snap.tamper_alarm.bad_index === 1,
    "runtime.json.tamper_alarm.bad_index should be 1"
  );
  console.log("[tamper] runtime.json.tamper_alarm surfaced to dashboard");

  // Export an incident — must write a new file under ops/data/incidents.
  const { path, incident_id } = exportIncident(state, {
    reason: "tamper_detection drill",
  });
  console.log(`[tamper] incident exported: ${incident_id} → ${path}`);

  const incidents = readdirSync(INCIDENTS_DIR).filter((f) =>
    f.startsWith("incident-")
  );
  assert(
    incidents.length === incidentsBefore + 1,
    `expected 1 new incident file (had ${incidentsBefore}, now ${incidents.length})`
  );

  // Sanity: loaded incident shows verify.ok=false.
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert(rec.audit.verify.ok === false, "incident.audit.verify.ok must be false after tamper");
  assert(rec.audit.verify.bad_index === 1, "incident.audit.verify.bad_index must be 1");
  assert(rec.adversarial_mode === true, "incident.adversarial_mode must be true");
  assert(rec.beliefs.total === 3, "incident.beliefs.total must be 3");

  // Detach so a clean "stopped" snapshot lands — keeps runtime.json tidy for
  // the dashboard observers that tailed along.
  writer.detach();

  // Move the runtime.json back to a "clean" post-stopped state by clearing the
  // alarm now that the drill is over. (The incident file remains on disk.)
  // We do this by touching state and flushing once more, but since the writer
  // is detached, we just re-write directly so dashboards don't show a stale
  // alarm forever.
  writer.setTamperAlarm(null);
  const clean = {
    ...snap,
    tamper_alarm: null,
    server_status: "stopped",
    last_op: "shutdown",
    updated_at: new Date().toISOString(),
  };
  const tmp = RUNTIME_PATH + ".tmp-" + process.pid;
  const fs = await import("node:fs");
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
  renameSync(tmp, RUNTIME_PATH);

  console.log("\n[tamper] ✓ Gate Tamper drill complete — tamper → alarm → incident captured.");
}

main().catch((err) => {
  console.error("[tamper] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
