/**
 * Record the shared BFSI scenario against a fresh EngineState, capture every
 * StreamEvent emitted, and write `ops/data/demo-fixtures.json` for the demo
 * dashboard to replay on GitHub Pages (where there's no live sidecar).
 *
 * Run:  pnpm demo:capture
 *
 * Output shape:
 *   {
 *     captured_at: "<ISO-8601>"
 *     commit:      "<git sha>",
 *     events: [StreamEvent, ...],
 *     event_count: <int>,
 *     scenario:    "bfsi-claims-triage-minimal"
 *   }
 *
 * The scenario itself lives in `scripts/demo_scenario.ts` so both this
 * capture path AND the live sidecar's `POST /api/demo/play` endpoint (Phase
 * O.5) drive the same 13-event narrative.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { EngineState } from "../src/engine/state.js";
import type { StreamEvent } from "../src/engine/stream_event.js";
import { BFSI_SCENARIO_LABEL, runBfsiScenario } from "./demo_scenario.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = resolve(REPO_ROOT, "ops/data/demo-fixtures.json");

function commitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const state = new EngineState();
  state.adversarialMode = true;
  const events: StreamEvent[] = [];
  state.onEvent = (e): void => {
    events.push(e);
  };

  await runBfsiScenario(state);

  const fixture = {
    schema_version: "1.0.0",
    captured_at: new Date().toISOString(),
    commit: commitSha(),
    events,
    event_count: events.length,
    scenario: BFSI_SCENARIO_LABEL,
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");
  process.stdout.write(
    `[demo-capture] wrote ${events.length} events → ${OUT_PATH.replace(REPO_ROOT + "/", "")}\n`
  );
}

main().catch((err) => {
  process.stderr.write(
    `[demo-capture] FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  );
  process.exit(1);
});
