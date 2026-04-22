/**
 * weavory.ai — persistence layer (interface + factory)
 *
 * Persistence is an opt-in side-effect hook bolted onto EngineState's mutation
 * points (`storeBelief`, `tombstone`, `appendAudit`, `setTrust`). It never
 * changes the in-memory API; it only mirrors writes to durable storage and
 * provides a `load()` path for startup rehydrate.
 *
 * Two backends share a single interface:
 *   - "jsonl"  — default. Pure Node (`fs.appendFileSync`). Zero native deps.
 *   - "duckdb" — optional. Loaded lazily via dynamic import. If the native
 *                binding fails to load for any reason (missing binary,
 *                ABI mismatch, bad arch, corrupt install), the factory logs a
 *                structured warning and transparently falls back to JSONL.
 *
 * This fallback is a deliberate architectural choice, not a workaround: native
 * Node addons have historical install-failure modes that we refuse to let
 * cascade into Gate 6 (fresh-machine CI) or the judge's install. DuckDB is a
 * runtime *capability*, not a hard dependency.
 *
 * The factory is async because ESM dynamic imports are async. Callers wire it
 * up once at startup (`weavory start`) and then attach the result to
 * EngineState synchronously.
 */
import type { AuditEntry, StoredBelief } from "../core/schema.js";
import { openJsonlStore } from "./persist_jsonl.js";

export type PersistKind = "jsonl" | "duckdb";

/** A trust attestation, persisted so attestations survive process restart. */
export type PersistedTrust = {
  signer_id: string;
  topic: string;
  score: number;
  recorded_at: string;
};

/** Side-channel diagnostics produced by `load()`. */
export type LoadDiagnostics = {
  beliefs_read: number;
  beliefs_skipped: number;
  audit_read: number;
  audit_skipped: number;
  trust_read: number;
  trust_skipped: number;
  warnings: string[];
};

export type LoadResult = {
  beliefs: StoredBelief[];
  audit: AuditEntry[];
  trust: PersistedTrust[];
  diagnostics: LoadDiagnostics;
};

export interface PersistentStore {
  readonly kind: PersistKind;
  readonly dataDir: string;
  writeBelief(belief: StoredBelief): void;
  writeAudit(entry: AuditEntry): void;
  writeTrust(t: PersistedTrust): void;
  load(): LoadResult;
  close(): void;
}

export type PersistOptions = {
  dataDir: string;
  preferred?: PersistKind;
  /** Sink for structured warnings. Defaults to stderr. */
  logger?: (msg: string) => void;
};

/** Default logger — stderr, one line per warning, prefixed for grep-ability. */
function defaultLogger(msg: string): void {
  process.stderr.write(`[persist] ${msg}\n`);
}

/**
 * Open a persistent store for the given data directory.
 *
 * If `preferred: "duckdb"` is requested, we attempt to load the DuckDB
 * adapter via dynamic import. This is the capability probe: if the `@duckdb/
 * node-api` native module cannot be resolved, loaded, or initialized, we log
 * a structured warning and fall back to JSONL. Callers can tell which backend
 * is active by reading `.kind` on the returned store.
 *
 * Rationale for graceful fallback (instead of throwing): DuckDB is declared
 * as an optionalDependency. On architectures where its prebuilt binary is
 * unavailable, `pnpm install` will not have installed it — we must not crash
 * in that environment. This is the same pattern Node uses for fsevents on
 * non-macOS platforms.
 */
export async function openPersistentStore(
  opts: PersistOptions
): Promise<PersistentStore> {
  const logger = opts.logger ?? defaultLogger;
  const preferred = opts.preferred ?? "jsonl";

  if (preferred === "duckdb") {
    try {
      const mod = await import("./persist_duckdb.js");
      const openFn = (mod as { openDuckdbStore?: unknown }).openDuckdbStore;
      if (typeof openFn !== "function") {
        throw new Error("persist_duckdb.openDuckdbStore export missing");
      }
      const store = await (openFn as (
        o: { dataDir: string; logger: (m: string) => void }
      ) => Promise<PersistentStore>)({ dataDir: opts.dataDir, logger });
      return store;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger(
        `duckdb backend unavailable (${reason}); falling back to jsonl. ` +
          `This is expected when the @duckdb/node-api binary is not installed ` +
          `for the current platform; see docs/DEPLOYMENT.md.`
      );
      // fall through to JSONL — do not surface the error to the caller
    }
  }

  return openJsonlStore({ dataDir: opts.dataDir, logger });
}

/**
 * Resolve the PersistKind from environment variables. Central so CLI, tests,
 * and potential future Docker entrypoints agree on the same parsing rules.
 */
export function kindFromEnv(env: NodeJS.ProcessEnv): PersistKind {
  const raw = (env.WEAVORY_STORE ?? "").trim().toLowerCase();
  if (raw === "duckdb") return "duckdb";
  // default (and any unrecognized value) is jsonl
  return "jsonl";
}

/**
 * True when the caller has asked for persistence. Kept alongside kindFromEnv
 * for symmetry; the default is OFF (in-memory only) to preserve Phase-1
 * behavior.
 */
export function persistEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.WEAVORY_PERSIST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Where to put persistent data when the user doesn't override. */
export function dataDirFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = (env.WEAVORY_DATA_DIR ?? "").trim();
  if (raw.length > 0) return raw;
  return "./.weavory-data";
}
