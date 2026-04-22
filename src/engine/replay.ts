/**
 * weavory.ai — incident replay (Phase G.4, W-0130)
 *
 * Loads an incident record from disk, rehydrates it into a fresh
 * `EngineState` (using `restoreEntries` so the original chain — including
 * any tampering captured at export time — is preserved byte-for-byte),
 * and runs a read-only query against it.
 *
 * Replay is a library module + a CLI surface — it never mutates the
 * original file and never alters a live running weavory process. Safe to
 * invoke against a frozen incident while the primary engine keeps
 * serving, because the replay state is in a separate EngineState.
 *
 * Subscriptions in the incident record are summarized (id, pattern,
 * queue_length) rather than fully captured — so the rehydrated engine
 * does NOT reproduce subscription queues. Queries that use
 * `subscription_id` against a replayed state will therefore return
 * delivered_count=0; that's intentional and documented.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { EngineState } from "./state.js";
import { StoredBeliefSchema, type StoredBelief } from "../core/schema.js";
import { recall, type RecallInput, type RecallOutput } from "./ops.js";
import type { IncidentRecord } from "./incident.js";

/**
 * Lightweight Zod guard for the OUTER shape of an IncidentRecord as loaded
 * from disk (Phase J.P1-4 · SEC-03). Interior `beliefs.records[]` and
 * `audit.entries[]` are parsed deeply by their own schemas during
 * rehydrate; here we only assert enough structure to short-circuit
 * obviously-malformed files (missing required top-level fields, wrong
 * types) with a clear error instead of a cryptic TypeError later.
 */
const LoadIncidentShape = z
  .object({
    schema_version: z.literal("1.0.0"),
    incident_id: z.string().min(1),
    exported_at: z.string().min(1),
    reason: z.union([z.string(), z.null()]).optional(),
    adversarial_mode: z.boolean().optional(),
    audit: z
      .object({
        length: z.number().int().nonnegative(),
        verify: z.unknown(),
        entries: z.array(z.unknown()),
      })
      .passthrough(),
    beliefs: z
      .object({
        total: z.number().int().nonnegative(),
        live: z.number().int().nonnegative(),
        quarantined: z.number().int().nonnegative(),
        tombstoned: z.number().int().nonnegative(),
        records: z.array(z.unknown()),
      })
      .passthrough(),
    trust: z.array(z.unknown()).optional(),
    subscriptions: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type LoadedIncident = {
  path: string;
  record: IncidentRecord;
};

export function loadIncident(path: string): LoadedIncident {
  const abs = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(
      `replay: cannot read incident file ${abs}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `replay: ${abs} is not valid JSON: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  // Preserve the explicit "unsupported schema_version" error message for
  // callers that match on it. Running this check BEFORE the full Zod
  // shape guard gives operators a targeted hint for the most common
  // upgrade mismatch.
  const anyRec = parsed as { schema_version?: unknown };
  if (anyRec.schema_version !== "1.0.0") {
    throw new Error(
      `replay: unsupported incident schema_version ${String(anyRec.schema_version)}`
    );
  }
  // Phase J.P1-4 · SEC-03 — validate outer shape before handing to
  // rehydrateState. Interior belief/audit records are still validated
  // deeply by their own schemas; this catches malformed or truncated
  // files with a structured error.
  const check = LoadIncidentShape.safeParse(parsed);
  if (!check.success) {
    const issues = check.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join(".") || "<root>"}:${i.message}`)
      .join("; ");
    throw new Error(
      `replay: incident record ${abs} failed outer shape validation: ${issues}`
    );
  }
  const record = check.data as unknown as IncidentRecord;
  return { path: abs, record };
}

/**
 * Reconstruct an EngineState from a record produced by `exportIncident`.
 * - Beliefs: parsed via StoredBeliefSchema and inserted via `storeBelief`.
 * - Audit chain: bulk-restored via `audit.restoreEntries` to preserve the
 *   captured hashes (including tampered ones).
 * - Trust vectors: populated via `setTrust`.
 * - Subscriptions: metadata only; queues are not captured and so not rebuilt.
 * - `adversarialMode` flag is carried across.
 *
 * `onOp` is NOT set — replay is a read-only sandbox and shouldn't write
 * to the host's ops/data/runtime.json.
 */
export function rehydrateState(record: IncidentRecord): EngineState {
  const s = new EngineState();
  s.adversarialMode = Boolean(record.adversarial_mode);

  const beliefs = Array.isArray(record.beliefs?.records) ? record.beliefs.records : [];
  for (const raw of beliefs) {
    const belief = StoredBeliefSchema.parse(raw) as StoredBelief;
    s.storeBelief(belief);
  }

  const entries = Array.isArray(record.audit?.entries) ? record.audit.entries : [];
  s.audit.restoreEntries(entries);

  const trust = Array.isArray(record.trust) ? record.trust : [];
  for (const t of trust) {
    if (typeof t.signer_id === "string" && typeof t.topic === "string" && typeof t.score === "number") {
      s.setTrust(t.signer_id, t.topic, t.score);
    }
  }
  return s;
}

export type ReplayOptions = {
  /** Search query. Default: empty (matches all). */
  query?: string;
  /** ISO-8601 bi-temporal `as_of` timestamp. Default: undefined (live view). */
  as_of?: string | null;
  /** Max beliefs to return. Default: 10. */
  top_k?: number;
  /**
   * Trust floor. Default -1 for replay so we see the full audit surface —
   * unlike live recall which gates at 0.3 (or 0.6 adversarial). Replay
   * callers opt back into a stricter view by passing an explicit value.
   */
  min_trust?: number;
  include_conflicts?: boolean;
  merge_strategy?: RecallInput["merge_strategy"];
};

export type ReplaySummary = {
  schema_version: "1.0.0";
  incident_id: string;
  exported_at: string;
  adversarial_mode: boolean;
  beliefs: { total: number; live: number; quarantined: number; tombstoned: number };
  audit: {
    length: number;
    verify: IncidentRecord["audit"]["verify"];
  };
};

export type ReplayResult = {
  summary: ReplaySummary;
  recall: RecallOutput;
};

/**
 * Run a `recall` against a rehydrated state, returning both the recall
 * result and a compact summary of the incident so callers can render
 * "what was true at export time" alongside "what this query returned".
 */
export function runReplay(
  state: EngineState,
  record: IncidentRecord,
  opts: ReplayOptions = {}
): ReplayResult {
  const recallInput: RecallInput = {
    query: opts.query ?? "",
    top_k: opts.top_k ?? 10,
    min_trust: opts.min_trust ?? -1,
  };
  if (opts.as_of !== undefined) recallInput.as_of = opts.as_of;
  if (opts.include_conflicts !== undefined) recallInput.include_conflicts = opts.include_conflicts;
  if (opts.merge_strategy !== undefined) recallInput.merge_strategy = opts.merge_strategy;
  const result = recall(state, recallInput);

  const summary: ReplaySummary = {
    schema_version: "1.0.0",
    incident_id: record.incident_id,
    exported_at: record.exported_at,
    adversarial_mode: Boolean(record.adversarial_mode),
    beliefs: {
      total: record.beliefs?.total ?? 0,
      live: record.beliefs?.live ?? 0,
      quarantined: record.beliefs?.quarantined ?? 0,
      tombstoned: record.beliefs?.tombstoned ?? 0,
    },
    audit: {
      length: record.audit?.length ?? 0,
      verify: record.audit?.verify ?? ({ ok: false, bad_index: -1, reason: "missing" } as never),
    },
  };
  return { summary, recall: result };
}
