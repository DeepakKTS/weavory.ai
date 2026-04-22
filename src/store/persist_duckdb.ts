/**
 * weavory.ai — DuckDB persistence adapter
 *
 * Implements PersistentStore against a single file-backed DuckDB database
 * (`<dataDir>/weavory.duckdb`). Schema mirrors the JSONL adapter: each record
 * is stored as a JSON blob alongside a few indexed columns for fast lookup,
 * so switching between the two backends is behaviorally transparent.
 *
 * IMPORTANT — Gate-6 binary-matrix safety
 * ======================================
 * This module MUST NOT hold a top-level `import '@duckdb/node-api'`. We load
 * the module via dynamic `await import()` inside the factory so that any of
 * the following failure modes degrades to JSONL fallback (in persist.ts)
 * without crashing startup:
 *
 *   1. Module not installed (pnpm with --ignore-optional, restricted runtime,
 *      platform where @duckdb/node-api ships no prebuilt binary).
 *   2. Binary loads but fails its native init (ABI mismatch, missing libc
 *      version, SELinux-restricted mmap, etc.).
 *   3. Runtime permission denial on the data directory.
 *
 * Every one of these is caught here or in `openPersistentStore` (persist.ts)
 * and surfaces as a single stderr warning; we never let it kill the process.
 *
 * Durability model
 * ================
 * Unlike the JSONL adapter (where `fs.appendFileSync` blocks until the OS
 * buffer has the bytes), the DuckDB Node binding is async-only. We preserve
 * the synchronous `PersistentStore.writeX` contract by enqueueing each write
 * onto a single-threaded promise chain so ORDER is preserved, but individual
 * writes are fire-and-forget from the caller's perspective: they return
 * before the write has hit disk. Durability is provided by DuckDB's WAL —
 * crash recovery replays unfinished transactions on next open — but a process
 * killed with SIGKILL may lose the last few milliseconds of writes.
 *
 * The semantic difference vs JSONL is documented in docs/DEPLOYMENT.md. For
 * hackathon scope + regulated-workflow demos this is an acceptable tradeoff;
 * for stricter guarantees callers should use JSONL (default).
 *
 * Single-writer invariant
 * =======================
 * DuckDB acquires an exclusive lock on the `.duckdb` file. Two weavory
 * processes pointed at the same `WEAVORY_DATA_DIR` with `WEAVORY_STORE=duckdb`
 * will cause the second to fail at open time — correct behavior, documented.
 */
import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import {
  AuditEntrySchema,
  StoredBeliefSchema,
  type AuditEntry,
  type StoredBelief,
} from "../core/schema.js";
import {
  type LoadDiagnostics,
  type LoadResult,
  type PersistedTrust,
  type PersistentStore,
} from "./persist.js";
import { z } from "zod";

type Logger = (msg: string) => void;

const PersistedTrustSchema = z
  .object({
    signer_id: z.string().regex(/^[0-9a-f]{64}$/u),
    topic: z.string().min(1).max(512),
    score: z.number().min(-1).max(1),
    recorded_at: z.string(),
  })
  .strict();

// Minimal structural types matching @duckdb/node-api — local types let us
// compile without a hard dependency on the package's .d.ts files, and make
// the code robust to minor API movement between DuckDB versions.
type DuckDBRunResult = {
  getRowObjects: () => Promise<Record<string, unknown>[]>;
};
type DuckDBConnection = {
  run: (sql: string, params?: unknown[]) => Promise<DuckDBRunResult>;
  close?: () => Promise<void> | void;
  closeSync?: () => void;
};
type DuckDBInstance = {
  connect: () => Promise<DuckDBConnection>;
  close?: () => Promise<void> | void;
  closeSync?: () => void;
};
type DuckDBModule = {
  DuckDBInstance: { create: (path: string) => Promise<DuckDBInstance> };
};

export async function openDuckdbStore(opts: {
  dataDir: string;
  logger: Logger;
}): Promise<PersistentStore> {
  const dataDir = resolve(opts.dataDir);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const dbPath = resolve(dataDir, "weavory.duckdb");

  // Dynamic import. If this throws — missing package, missing native binary,
  // ABI mismatch — the error bubbles back up to `openPersistentStore` which
  // logs + falls back to JSONL. That is the designed path, not an exception.
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDBModule;
  if (!mod?.DuckDBInstance || typeof mod.DuckDBInstance.create !== "function") {
    throw new Error("@duckdb/node-api loaded but DuckDBInstance.create is missing");
  }

  const db = await mod.DuckDBInstance.create(dbPath);
  const conn = await db.connect();
  await initSchema(conn);

  // Single-threaded promise chain preserving write ORDER. Errors are logged
  // but do NOT break the chain — one bad write must not poison subsequent
  // writes. Callers using DuckDB get "ordered + eventually-durable" instead
  // of the JSONL "synchronously durable" guarantee (documented in
  // docs/DEPLOYMENT.md).
  let writeChain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>, label: string): void => {
    writeChain = writeChain.then(op, () => op()).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger(`duckdb ${label} write failed: ${msg}`);
    });
  };

  // Prime the synchronous `load()` by fetching everything once at open.
  const initialLoad = await readAll(conn);

  const store: PersistentStore = {
    kind: "duckdb",
    dataDir,

    writeBelief(belief: StoredBelief): void {
      const checked = StoredBeliefSchema.parse(belief);
      enqueue(
        () =>
          conn.run(
            `INSERT OR REPLACE INTO beliefs
               (id, belief_json, signer_id, predicate, subject, ingested_at, invalidated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              checked.id,
              JSON.stringify(checked),
              checked.signer_id,
              checked.predicate,
              checked.subject,
              checked.ingested_at,
              checked.invalidated_at,
            ]
          ),
        "writeBelief"
      );
    },

    writeAudit(entry: AuditEntry): void {
      const checked = AuditEntrySchema.parse(entry);
      enqueue(
        () =>
          conn.run(
            `INSERT INTO audit
               (seq, entry_hash, prev_hash, belief_id, signer_id, operation, recorded_at, entry_json)
             VALUES (nextval('audit_seq'), ?, ?, ?, ?, ?, ?, ?)`,
            [
              checked.entry_hash,
              checked.prev_hash,
              checked.belief_id,
              checked.signer_id,
              checked.operation,
              checked.recorded_at,
              JSON.stringify(checked),
            ]
          ),
        "writeAudit"
      );
    },

    writeTrust(t: PersistedTrust): void {
      const checked = PersistedTrustSchema.parse(t);
      enqueue(
        () =>
          conn.run(
            `INSERT OR REPLACE INTO trust (signer_id, topic, score, recorded_at)
             VALUES (?, ?, ?, ?)`,
            [checked.signer_id, checked.topic, checked.score, checked.recorded_at]
          ),
        "writeTrust"
      );
    },

    load(): LoadResult {
      // The one-shot initial load captured at open time is the durable view
      // as of open. In-process subsequent writes are not reflected here
      // (callers use EngineState's in-memory view for that); this method is
      // for startup rehydrate.
      return initialLoad;
    },

    async close(): Promise<void> {
      // Drain the queue then close the connection + db. We capture the tail
      // of the chain (writeChain already swallows its own errors via the
      // enqueue wrapper, so this never rejects) and return a Promise that
      // resolves when BOTH the queued writes and the closeAll have
      // completed. Eliminates the earlier time-based `drain()` workaround
      // that was flaky on slow CI filesystems.
      const barrier = writeChain.then(
        () => closeAll(conn, db),
        () => closeAll(conn, db)
      );
      writeChain = barrier;
      await barrier;
    },
  };

  return store;
}

// ---------- internals ----------

async function initSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run(
    `CREATE TABLE IF NOT EXISTS beliefs (
       id VARCHAR PRIMARY KEY,
       belief_json VARCHAR NOT NULL,
       signer_id VARCHAR NOT NULL,
       predicate VARCHAR NOT NULL,
       subject VARCHAR NOT NULL,
       ingested_at VARCHAR NOT NULL,
       invalidated_at VARCHAR
     )`
  );
  await conn.run(
    `CREATE TABLE IF NOT EXISTS audit (
       seq BIGINT PRIMARY KEY,
       entry_hash VARCHAR NOT NULL,
       prev_hash VARCHAR NOT NULL,
       belief_id VARCHAR NOT NULL,
       signer_id VARCHAR NOT NULL,
       operation VARCHAR NOT NULL,
       recorded_at VARCHAR NOT NULL,
       entry_json VARCHAR NOT NULL
     )`
  );
  await conn.run(
    `CREATE TABLE IF NOT EXISTS trust (
       signer_id VARCHAR NOT NULL,
       topic VARCHAR NOT NULL,
       score DOUBLE NOT NULL,
       recorded_at VARCHAR NOT NULL,
       PRIMARY KEY (signer_id, topic)
     )`
  );
  await conn.run(`CREATE SEQUENCE IF NOT EXISTS audit_seq START 1`);
}

async function readAll(conn: DuckDBConnection): Promise<LoadResult> {
  const diagnostics: LoadDiagnostics = {
    beliefs_read: 0,
    beliefs_skipped: 0,
    audit_read: 0,
    audit_skipped: 0,
    trust_read: 0,
    trust_skipped: 0,
    warnings: [],
  };

  const beliefs: StoredBelief[] = [];
  for (const row of await (await conn.run(`SELECT belief_json FROM beliefs`)).getRowObjects()) {
    try {
      const parsed = JSON.parse(String(row.belief_json));
      const checked = StoredBeliefSchema.safeParse(parsed);
      if (checked.success) beliefs.push(checked.data);
      else diagnostics.beliefs_skipped += 1;
    } catch {
      diagnostics.beliefs_skipped += 1;
    }
  }

  const audit: AuditEntry[] = [];
  for (const row of await (
    await conn.run(`SELECT entry_json FROM audit ORDER BY seq ASC`)
  ).getRowObjects()) {
    try {
      const parsed = JSON.parse(String(row.entry_json));
      const checked = AuditEntrySchema.safeParse(parsed);
      if (checked.success) audit.push(checked.data);
      else diagnostics.audit_skipped += 1;
    } catch {
      diagnostics.audit_skipped += 1;
    }
  }

  const trust: PersistedTrust[] = [];
  for (const row of await (
    await conn.run(`SELECT signer_id, topic, score, recorded_at FROM trust`)
  ).getRowObjects()) {
    const checked = PersistedTrustSchema.safeParse({
      signer_id: String(row.signer_id),
      topic: String(row.topic),
      score: Number(row.score),
      recorded_at: String(row.recorded_at),
    });
    if (checked.success) trust.push(checked.data);
    else diagnostics.trust_skipped += 1;
  }

  diagnostics.beliefs_read = beliefs.length;
  diagnostics.audit_read = audit.length;
  diagnostics.trust_read = trust.length;

  return { beliefs, audit, trust, diagnostics };
}

async function closeAll(conn: DuckDBConnection, db: DuckDBInstance): Promise<void> {
  try {
    if (typeof conn.close === "function") await conn.close();
    else if (typeof conn.closeSync === "function") conn.closeSync();
  } catch {
    // best-effort
  }
  try {
    if (typeof db.close === "function") await db.close();
    else if (typeof db.closeSync === "function") db.closeSync();
  } catch {
    // best-effort
  }
}
