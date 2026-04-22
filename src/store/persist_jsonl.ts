/**
 * weavory.ai — JSONL persistence adapter
 *
 * File layout under `dataDir`:
 *   beliefs.jsonl   — one StoredBelief per line. Insert + tombstone both
 *                     append a fresh line; last-write-wins on replay.
 *   audit.jsonl     — one AuditEntry per line (strict append-only by design).
 *   trust.jsonl     — one PersistedTrust per line. Last-write-wins on replay.
 *
 * Each file begins with one meta line, e.g.
 *   {"_meta":{"schema_version":"1.0.0","kind":"belief","created_at":"…"}}
 * Parser recognizes and skips meta lines so format evolution is straightforward.
 *
 * Write policy: `fs.appendFileSync` with a single newline-terminated record.
 * Node uses `open(path, "a")` which maps to POSIX `O_APPEND`. On Linux/macOS,
 * appends up to PIPE_BUF (4096 bytes) are atomic with respect to concurrent
 * appenders — more than enough for one belief per call. The single-writer
 * invariant (one weavory process per `dataDir`) is documented in
 * docs/DEPLOYMENT.md.
 *
 * Read policy: `fs.readFileSync` + line-by-line parse. Each line is
 * independently validated by its Zod schema; an invalid line is logged and
 * skipped (does NOT abort load). A truncated final line (half-written record
 * due to a crash mid-write) parses as invalid JSON and is therefore skipped
 * exactly like any other corruption.
 *
 * Edge cases handled explicitly:
 *   - Missing dataDir            → mkdir recursive on first write
 *   - Missing file on load       → return empty arrays, no warning
 *   - Empty file (0 bytes)       → return empty, no warning
 *   - File with only meta line   → return empty, no warning
 *   - Invalid JSON line          → skip + increment `*_skipped`, warn once
 *                                  with line number
 *   - Valid JSON failing Zod     → skip + warn (schema skew)
 *   - Truncated last line        → same as invalid JSON
 *   - Permission denied on write → throw with operator-actionable message
 *   - Empty trailing line        → ignored (common editor artifact)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

const BELIEFS_FILE = "beliefs.jsonl";
const AUDIT_FILE = "audit.jsonl";
const TRUST_FILE = "trust.jsonl";

/** Persisted trust row — Zod schema for the load path. */
const PersistedTrustSchema = z
  .object({
    signer_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/u, "must be 64 lower-case hex chars (32 bytes)"),
    topic: z.string().min(1).max(512),
    score: z.number().min(-1).max(1),
    recorded_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u),
  })
  .strict();

type Logger = (msg: string) => void;

export interface JsonlStore extends PersistentStore {
  readonly kind: "jsonl";
}

export function openJsonlStore(opts: { dataDir: string; logger: Logger }): JsonlStore {
  const dataDir = resolve(opts.dataDir);
  ensureDir(dataDir);

  const beliefsPath = resolve(dataDir, BELIEFS_FILE);
  const auditPath = resolve(dataDir, AUDIT_FILE);
  const trustPath = resolve(dataDir, TRUST_FILE);

  // Seed meta lines on brand-new files so future format evolution is cleaner.
  seedMeta(beliefsPath, "belief", opts.logger);
  seedMeta(auditPath, "audit", opts.logger);
  seedMeta(trustPath, "trust", opts.logger);

  const store: JsonlStore = {
    kind: "jsonl",
    dataDir,

    writeBelief(belief: StoredBelief): void {
      // We validate on the write side too; an invalid belief must NEVER reach
      // disk or the load path would quietly drop it. Callers upstream already
      // validate, so this is cheap belt-and-suspenders for future refactors.
      const checked = StoredBeliefSchema.parse(belief);
      appendLine(beliefsPath, checked);
    },

    writeAudit(entry: AuditEntry): void {
      const checked = AuditEntrySchema.parse(entry);
      appendLine(auditPath, checked);
    },

    writeTrust(t: PersistedTrust): void {
      const checked = PersistedTrustSchema.parse(t);
      appendLine(trustPath, checked);
    },

    load(): LoadResult {
      const diagnostics: LoadDiagnostics = {
        beliefs_read: 0,
        beliefs_skipped: 0,
        audit_read: 0,
        audit_skipped: 0,
        trust_read: 0,
        trust_skipped: 0,
        warnings: [],
      };

      // Beliefs: replay with last-write-wins on id.
      const beliefsById = new Map<string, StoredBelief>();
      for (const rec of loadLines(beliefsPath, StoredBeliefSchema, diagnostics, "beliefs", opts.logger)) {
        beliefsById.set(rec.id, rec);
      }

      // Audit: strict append order preserved.
      const audit: AuditEntry[] = [];
      for (const rec of loadLines(auditPath, AuditEntrySchema, diagnostics, "audit", opts.logger)) {
        audit.push(rec);
      }

      // Trust: last-write-wins on (signer_id, topic).
      const trustMap = new Map<string, PersistedTrust>();
      for (const rec of loadLines(
        trustPath,
        PersistedTrustSchema,
        diagnostics,
        "trust",
        opts.logger
      )) {
        trustMap.set(`${rec.signer_id}::${rec.topic}`, rec);
      }

      diagnostics.beliefs_read = beliefsById.size;
      diagnostics.audit_read = audit.length;
      diagnostics.trust_read = trustMap.size;

      return {
        beliefs: Array.from(beliefsById.values()),
        audit,
        trust: Array.from(trustMap.values()),
        diagnostics,
      };
    },

    close(): void {
      // JSONL store holds no file handles between calls — every appendFileSync
      // opens + writes + closes atomically. Nothing to release here; the
      // method is present for interface parity with the DuckDB adapter.
    },
  };

  return store;
}

// ---------- internals ----------

function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
}

function seedMeta(
  path: string,
  kind: "belief" | "audit" | "trust",
  _logger: Logger
): void {
  if (existsSync(path)) return;
  ensureDir(dirname(path));
  const meta = {
    _meta: {
      schema_version: "1.0.0",
      kind,
      created_at: new Date().toISOString(),
    },
  };
  writeFileSync(path, JSON.stringify(meta) + "\n", "utf8");
}

function appendLine(path: string, record: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

function isMetaLine(line: string): boolean {
  // Cheap prefix check before JSON.parse — meta lines start with `{"_meta":`.
  return line.startsWith('{"_meta"');
}

function* loadLines<T>(
  path: string,
  schema: z.ZodType<T>,
  diagnostics: LoadDiagnostics,
  kind: "beliefs" | "audit" | "trust",
  logger: Logger
): Generator<T> {
  if (!existsSync(path)) return;

  const raw = readFileSync(path, "utf8");
  if (raw.length === 0) return;

  const lines = raw.split("\n");
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    if (line.length === 0) continue; // trailing newline or blank line
    if (isMetaLine(line)) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      incSkipped(diagnostics, kind);
      const msg = `${kind} line ${lineNo} invalid JSON; skipping (likely crash-truncated)`;
      pushWarnOnce(diagnostics, logger, msg);
      continue;
    }

    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      incSkipped(diagnostics, kind);
      const msg =
        `${kind} line ${lineNo} failed schema validation: ` +
        result.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; ");
      pushWarnOnce(diagnostics, logger, msg);
      continue;
    }

    yield result.data;
  }
}

function incSkipped(d: LoadDiagnostics, kind: "beliefs" | "audit" | "trust"): void {
  if (kind === "beliefs") d.beliefs_skipped += 1;
  else if (kind === "audit") d.audit_skipped += 1;
  else d.trust_skipped += 1;
}

function pushWarnOnce(d: LoadDiagnostics, logger: Logger, msg: string): void {
  d.warnings.push(msg);
  logger(msg);
}
