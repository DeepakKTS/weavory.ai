/**
 * weavory.ai — BLAKE3 hash-chained audit log
 *
 * Every write to weavory (believe / attest / forget) appends one AuditEntry.
 * Each entry's `entry_hash` = blake3(canonical_json(<entry without entry_hash>)).
 * Since the pre-hash payload *includes* `prev_hash`, the chain is tamper-evident:
 * modifying any past entry invalidates all later hashes.
 *
 * This module is pure: no I/O. Callers wire persistence via `src/store/audit.ts`.
 */
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { canonicalJson } from "./belief.js";
import {
  AuditEntrySchema,
  GENESIS_PREV_HASH,
  type AuditEntry,
  type AuditOperation,
  type JsonValue,
} from "./schema.js";

export function computeEntryHash(input: {
  prev_hash: string;
  belief_id: string;
  signer_id: string;
  operation: AuditOperation;
  recorded_at: string;
}): string {
  const canonical = canonicalJson(input as unknown as JsonValue);
  const bytes = new TextEncoder().encode(canonical);
  return bytesToHex(blake3(bytes));
}

export function makeAuditEntry(input: {
  prev_hash: string;
  belief_id: string;
  signer_id: string;
  operation: AuditOperation;
  recorded_at: string;
}): AuditEntry {
  const entry_hash = computeEntryHash(input);
  const entry: AuditEntry = {
    entry_hash,
    prev_hash: input.prev_hash,
    belief_id: input.belief_id,
    signer_id: input.signer_id,
    operation: input.operation,
    recorded_at: input.recorded_at,
  };
  return AuditEntrySchema.parse(entry);
}

/** Chain verification result. On failure, reports the first bad index. */
export type ChainVerifyResult =
  | { ok: true; length: number }
  | { ok: false; bad_index: number; reason: "prev_hash" | "entry_hash" | "schema" };

/**
 * Verify the chain from genesis to end:
 *  - entry[0].prev_hash === GENESIS_PREV_HASH
 *  - for i > 0: entry[i].prev_hash === entry[i-1].entry_hash
 *  - every entry's entry_hash matches its content
 */
export function verifyChain(entries: AuditEntry[]): ChainVerifyResult {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const parsed = AuditEntrySchema.safeParse(e);
    if (!parsed.success) return { ok: false, bad_index: i, reason: "schema" };

    const expectedPrev = i === 0 ? GENESIS_PREV_HASH : entries[i - 1].entry_hash;
    if (parsed.data.prev_hash !== expectedPrev) {
      return { ok: false, bad_index: i, reason: "prev_hash" };
    }

    const recomputed = computeEntryHash({
      prev_hash: parsed.data.prev_hash,
      belief_id: parsed.data.belief_id,
      signer_id: parsed.data.signer_id,
      operation: parsed.data.operation,
      recorded_at: parsed.data.recorded_at,
    });
    if (recomputed !== parsed.data.entry_hash) {
      return { ok: false, bad_index: i, reason: "entry_hash" };
    }
  }
  return { ok: true, length: entries.length };
}
