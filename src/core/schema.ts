/**
 * weavory.ai — belief schema (Zod)
 *
 * The Belief is the only first-class object in weavory. Every public MCP
 * tool reads or writes beliefs. The shape here is a *superset* of NANDA
 * AgentFacts — an AgentFact {agent_id, capability, signature, ...} maps to
 * a Belief {subject=agent_id, predicate="has_capability", object=capability, signer_id, signature, ...}.
 *
 * Fields are split into three layers:
 *  1. BeliefPayload        — signed, immutable content.
 *  2. SignedBelief         — payload + id (content-addressed) + signature.
 *  3. StoredBelief         — SignedBelief + server-side transaction-time fields.
 *
 * The signature is computed over the canonical JSON encoding of BeliefPayload
 * (see `belief.ts` for canonicalization). The id is `blake3(canonical_payload)`.
 */
import { z } from "zod";

/** Reserved, pinned per ADR-005 to make wire compatibility explicit. */
export const SCHEMA_VERSION = "1.0.0" as const;

/** ISO-8601 extended — generated with `new Date().toISOString()`. */
const Iso8601 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u, "must be ISO-8601 Zulu (…Z)");

/** 32-byte Ed25519 public key, hex-encoded (64 lower-hex chars). */
const HexKey32 = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "must be 64 lower-case hex chars (32 bytes)");

/** 64-byte Ed25519 signature, hex-encoded. */
const HexSig64 = z
  .string()
  .regex(/^[0-9a-f]{128}$/u, "must be 128 lower-case hex chars (64 bytes)");

/** 32-byte BLAKE3 hash. Used for belief ids and audit-chain entries. */
const HexHash32 = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "must be 64 lower-case hex chars (32 bytes)");

/** JSON-serializable object/value allowed in `object`. Deliberately wide. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** What the signer commits to. Everything here is part of the signed bytes. */
export const BeliefPayloadSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    subject: z.string().min(1).max(2048),
    predicate: z.string().min(1).max(512),
    object: JsonValueSchema,
    confidence: z.number().min(0).max(1),
    valid_from: Iso8601.nullable(),
    valid_to: Iso8601.nullable(),
    recorded_at: Iso8601,
    signer_id: HexKey32,
    causes: z.array(HexHash32).max(64),
  })
  .strict();

export type BeliefPayload = z.infer<typeof BeliefPayloadSchema>;

/** Payload + content-address (id) + Ed25519 signature. Immutable once created. */
export const SignedBeliefSchema = BeliefPayloadSchema.extend({
  id: HexHash32,
  signature: HexSig64,
}).strict();

export type SignedBelief = z.infer<typeof SignedBeliefSchema>;

/** Server-side transaction-time metadata (not part of the signature). */
export const StoredBeliefSchema = SignedBeliefSchema.extend({
  ingested_at: Iso8601,
  invalidated_at: Iso8601.nullable(),
  invalidated_by: HexHash32.nullable(),
  quarantined: z.boolean(),
  quarantine_reason: z.string().nullable(),
}).strict();

export type StoredBelief = z.infer<typeof StoredBeliefSchema>;

/** Audit-chain entry. One per belief/operation, hash-linked. */
export const AuditOperationSchema = z.enum(["believe", "attest", "forget"]);
export type AuditOperation = z.infer<typeof AuditOperationSchema>;

export const AuditEntrySchema = z
  .object({
    entry_hash: HexHash32,
    prev_hash: HexHash32,
    belief_id: HexHash32,
    signer_id: HexKey32,
    operation: AuditOperationSchema,
    recorded_at: Iso8601,
  })
  .strict();

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/**
 * Sentinel for the genesis entry's prev_hash — 32 zero bytes as hex. This is
 * the only entry without a true predecessor; verification treats it specially.
 */
export const GENESIS_PREV_HASH = "0".repeat(64) as string;
