#!/usr/bin/env node
/**
 * weavory — CLI entrypoint
 *
 * Commands:
 *   weavory start
 *     Run the MCP server over stdio (the Phase-1 judge path).
 *
 *   weavory replay --from <incident.json> [--query <q>] [--as-of <iso>]
 *                  [--top-k <n>] [--min-trust <f>] [--include-conflicts]
 *                  [--merge-strategy <lww|consensus>] [--json]
 *     Load an exported incident and run a read-only `recall` against the
 *     rehydrated state. Prints a compact human summary by default; pass
 *     `--json` for machine-readable output.
 *
 * The binary is `weavory` via the package.json `bin` field after `pnpm build`.
 * During development, use `pnpm dev` which runs this under tsx.
 */
import { runStdio } from "./mcp/server.js";
import { loadIncident, rehydrateState, runReplay, type ReplayOptions } from "./engine/replay.js";

const HELP = `weavory — shared belief coordination substrate for AI agents

USAGE:
  weavory start
      Start the MCP server over stdio (default).

  weavory replay --from <incident.json> [options]
      Load an exported incident and run a recall against the rehydrated state.

      --from <path>           Path to an ops/data/incidents/*.json file (required).
      --query <str>           Substring query. Default "" (matches everything).
      --as-of <iso>           Bi-temporal recall at the given ISO-8601 timestamp.
      --top-k <n>             Max beliefs returned (default 10).
      --min-trust <f>         Trust floor (default -1 for replay audit view).
      --include-conflicts     Surface conflict groups in the output.
      --merge-strategy <s>    "lww" or "consensus" (default: no merge).
      --json                  Emit structured JSON instead of human text.

Docs: https://github.com/DeepakKTS/weavory.ai
`;

function die(msg: string, code = 2): never {
  process.stderr.write(`[weavory] ${msg}\n`);
  process.exit(code);
}

function readNextValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`missing value for ${flag}`);
  return v;
}

function parseReplayArgs(argv: string[]): {
  from: string;
  opts: ReplayOptions;
  emitJson: boolean;
} {
  let from: string | undefined;
  const opts: ReplayOptions = {};
  let emitJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from":
        from = readNextValue(argv, i, arg);
        i++;
        break;
      case "--query":
        opts.query = readNextValue(argv, i, arg);
        i++;
        break;
      case "--as-of":
        opts.as_of = readNextValue(argv, i, arg);
        i++;
        break;
      case "--top-k": {
        const n = Number(readNextValue(argv, i, arg));
        if (!Number.isFinite(n) || n < 1) die(`--top-k must be a positive integer`);
        opts.top_k = Math.floor(n);
        i++;
        break;
      }
      case "--min-trust": {
        const f = Number(readNextValue(argv, i, arg));
        if (!Number.isFinite(f) || f < -1 || f > 1) die(`--min-trust must be in [-1,1]`);
        opts.min_trust = f;
        i++;
        break;
      }
      case "--include-conflicts":
        opts.include_conflicts = true;
        break;
      case "--merge-strategy": {
        const v = readNextValue(argv, i, arg);
        if (v !== "lww" && v !== "consensus") die(`--merge-strategy must be lww or consensus`);
        opts.merge_strategy = v;
        i++;
        break;
      }
      case "--json":
        emitJson = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        die(`unknown replay flag: ${arg}`);
    }
  }
  if (!from) die(`replay requires --from <incident.json>`);
  return { from, opts, emitJson };
}

function printHumanReplay(
  result: ReturnType<typeof runReplay>,
  opts: ReplayOptions
): void {
  const { summary, recall } = result;
  const verify = summary.audit.verify;
  const verifyText = verify.ok
    ? `ok (length=${verify.length})`
    : `BAD (bad_index=${verify.bad_index} reason=${verify.reason})`;

  process.stdout.write(
    `[replay] loaded ${summary.incident_id} (exported ${summary.exported_at})\n` +
      `[replay]   adversarial_mode=${summary.adversarial_mode} beliefs=total:${summary.beliefs.total}/live:${summary.beliefs.live}/tombstoned:${summary.beliefs.tombstoned}/quarantined:${summary.beliefs.quarantined}\n` +
      `[replay]   audit length=${summary.audit.length} verify=${verifyText}\n`
  );

  const qDesc = opts.query && opts.query.length > 0 ? JSON.stringify(opts.query) : "\"\"";
  const asOfDesc = opts.as_of ? ` as_of=${opts.as_of}` : "";
  const minTrustDesc =
    opts.min_trust !== undefined ? ` min_trust=${opts.min_trust}` : " min_trust=-1";
  const mergeDesc = opts.merge_strategy ? ` merge_strategy=${opts.merge_strategy}` : "";
  process.stdout.write(
    `[replay] running recall(query=${qDesc}${asOfDesc}${minTrustDesc}${mergeDesc})\n`
  );
  process.stdout.write(
    `[replay] matched=${recall.total_matched} returned=${recall.beliefs.length}\n`
  );
  for (const b of recall.beliefs) {
    process.stdout.write(
      `  - ${b.subject} / ${b.predicate} = ${JSON.stringify(b.object)}` +
        ` (confidence=${b.confidence}, signer=${b.signer_id.slice(0, 12)}…)\n`
    );
  }
  if (recall.conflicts && recall.conflicts.length > 0) {
    process.stdout.write(`[replay] conflicts: ${recall.conflicts.length} group(s)\n`);
    for (const g of recall.conflicts) {
      process.stdout.write(
        `    · ${g.subject}/${g.predicate} · ${g.variants.length} variants · winner=${g.winner.id.slice(0, 12)}…\n`
      );
    }
  }
}

function runReplayCommand(argv: string[]): void {
  const { from, opts, emitJson } = parseReplayArgs(argv);
  const { record } = loadIncident(from);
  const state = rehydrateState(record);
  const result = runReplay(state, record, opts);
  if (emitJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    printHumanReplay(result, opts);
  }
}

const cmd = process.argv[2] ?? "start";

try {
  if (cmd === "start") {
    runStdio().catch((err) => {
      process.stderr.write(
        `[weavory] fatal: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
  } else if (cmd === "replay") {
    runReplayCommand(process.argv.slice(3));
  } else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  } else {
    process.stderr.write(`[weavory] unknown command: ${cmd}\nTry: weavory --help\n`);
    process.exit(2);
  }
} catch (err) {
  process.stderr.write(`[weavory] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
