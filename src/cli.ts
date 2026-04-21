#!/usr/bin/env node
/**
 * weavory — CLI entrypoint
 *
 * Usage:
 *   weavory start    # run the MCP server over stdio (the default)
 *
 * The binary is `weavory` via the package.json `bin` field after `pnpm build`.
 * During development, use `pnpm dev` which runs this under tsx.
 */
import { runStdio } from "./mcp/server.js";

const cmd = process.argv[2] ?? "start";

if (cmd === "start") {
  runStdio().catch((err) => {
    // Don't write to stdout — that's the MCP transport channel.
    process.stderr.write(`[weavory] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else if (cmd === "--help" || cmd === "-h") {
  process.stdout.write(
    "weavory — shared belief coordination substrate for AI agents\n\nUSAGE:\n  weavory start\n\nDocs: https://github.com/DeepakKTS/weavory.ai\n"
  );
  process.exit(0);
} else {
  process.stderr.write(`[weavory] unknown command: ${cmd}\nTry: weavory start\n`);
  process.exit(2);
}
