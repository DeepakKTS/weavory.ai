/**
 * Integration — persistence survives a REAL subprocess restart.
 *
 * This test differs from `persistence.test.ts` in one important way: it
 * exercises the full `node_modules/.bin/tsx src/cli.ts start` entrypoint
 * under a fresh child process, connects via the official MCP SDK stdio
 * client, writes a belief, terminates the child, spawns a second child
 * against the same `WEAVORY_DATA_DIR`, and asserts the belief id returned
 * by `weavory_recall` matches.
 *
 * Two tests:
 *   1. JSONL (always runs)     — zero native deps, default backend.
 *   2. DuckDB (conditional)    — `beforeAll` probes `@duckdb/node-api`;
 *                                skipped if the native binding can't load,
 *                                so Gate 6 stays green on any arch.
 *
 * Gate-6 / CI safety:
 * - Uses the same tsx shim every gate script uses, so platform parity is
 *   already proven.
 * - Cleans up each tmp data dir in `afterEach`.
 * - Per-test timeout 30 s (expected ~3–5 s on local; headroom for CI).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const CLI_SRC = resolve(REPO_ROOT, "src/cli.ts");

const PER_TEST_TIMEOUT_MS = 30_000;

type Session = { client: Client; close: () => Promise<void> };

async function openSession(env: NodeJS.ProcessEnv): Promise<Session> {
  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [CLI_SRC, "start"],
    env: { ...process.env, ...env } as Record<string, string>,
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  const client = new Client({ name: "persist-subproc", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    async close() {
      // Closing the client sends SIGTERM to the child via the transport.
      await client.close();
    },
  };
}

async function runOne<T>(env: NodeJS.ProcessEnv, fn: (c: Client) => Promise<T>): Promise<T> {
  const s = await openSession(env);
  try {
    return await fn(s.client);
  } finally {
    await s.close();
  }
}

async function believeOnce(env: NodeJS.ProcessEnv, subject: string): Promise<string> {
  return runOne(env, async (c) => {
    const r = await c.callTool({
      name: "weavory_believe",
      arguments: {
        subject,
        predicate: "observation",
        object: { survived_restart: true },
        signer_seed: "alice-subproc",
      },
    });
    const sc = r.structuredContent as { id: string; audit_length: number } | undefined;
    if (!sc || typeof sc.id !== "string") {
      throw new Error(`believe returned no structuredContent.id: ${JSON.stringify(r)}`);
    }
    return sc.id;
  });
}

async function recallOnce(
  env: NodeJS.ProcessEnv,
  query: string
): Promise<{ total_matched: number; ids: string[] }> {
  return runOne(env, async (c) => {
    const r = await c.callTool({
      name: "weavory_recall",
      arguments: { query, top_k: 5, min_trust: -1 },
    });
    const sc = r.structuredContent as
      | { total_matched: number; beliefs: Array<{ id: string }> }
      | undefined;
    if (!sc) throw new Error(`recall returned no structuredContent: ${JSON.stringify(r)}`);
    return {
      total_matched: sc.total_matched,
      ids: sc.beliefs.map((b) => b.id),
    };
  });
}

// ---------------- DuckDB capability probe ----------------

let duckdbAvailable = false;

beforeAll(async () => {
  try {
    await import("@duckdb/node-api");
    duckdbAvailable = true;
  } catch {
    duckdbAvailable = false;
  }
});

// ---------------- tmp-dir scaffolding ----------------

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "weavory-persist-subproc-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// Track any lingering child processes; Vitest's own teardown normally
// handles this via StdioClientTransport.close(), but a failed assertion
// mid-test can leak a child. `process.exit` traps aren't nice in tests;
// rely on transport close + the OS to reap.
afterAll(() => {});

// ---------------- tests ----------------

describe("persistence — subprocess restart round-trip", () => {
  it(
    "JSONL: believe in child 1, recall same id in child 2 after child 1 exits",
    async () => {
      const env: NodeJS.ProcessEnv = {
        WEAVORY_PERSIST: "1",
        WEAVORY_DATA_DIR: dataDir,
        WEAVORY_STORE: "jsonl",
        WEAVORY_RUNTIME_WRITER: "off",
        VITEST: "true",
      };
      const written = await believeOnce(env, "scene:subproc-jsonl");
      expect(written).toMatch(/^[0-9a-f]{64}$/);

      const recalled = await recallOnce(env, "subproc-jsonl");
      expect(recalled.total_matched).toBe(1);
      expect(recalled.ids).toContain(written);
    },
    PER_TEST_TIMEOUT_MS
  );

  it(
    "DuckDB: believe in child 1, recall same id in child 2 after child 1 exits (skipped if binary unavailable)",
    async () => {
      if (!duckdbAvailable) {
        // Gate-6 safety: when the DuckDB native binding is absent on this
        // CI arch / machine, we do NOT fail — the system's documented
        // fallback already handles this path. The JSONL test above is the
        // durability guarantee; DuckDB is opt-in.
        return;
      }
      const env: NodeJS.ProcessEnv = {
        WEAVORY_PERSIST: "1",
        WEAVORY_DATA_DIR: dataDir,
        WEAVORY_STORE: "duckdb",
        WEAVORY_RUNTIME_WRITER: "off",
        VITEST: "true",
      };
      const written = await believeOnce(env, "scene:subproc-duckdb");
      expect(written).toMatch(/^[0-9a-f]{64}$/);

      // Let DuckDB's async write queue drain + release its file lock before
      // the second child tries to open the same file. 400 ms is generous;
      // local observations show < 50 ms.
      await new Promise((r) => setTimeout(r, 400));

      const recalled = await recallOnce(env, "subproc-duckdb");
      expect(recalled.total_matched).toBe(1);
      expect(recalled.ids).toContain(written);
    },
    PER_TEST_TIMEOUT_MS
  );
});
