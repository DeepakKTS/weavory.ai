/**
 * weavory.ai — belief construction + canonicalization
 *
 * Canonical JSON: sorted-keys, no whitespace, RFC 8259 escapes. Used as the
 * input to signature and content-address (blake3) hashes. Both signer and
 * verifier must produce identical bytes — this module is the only place that
 * turns a payload into bytes for signing.
 *
 * NANDA AgentFacts interop: see `agentFactToBelief` below. The helpers are
 * intentionally small; mappings beyond the basic shape live in docs/NANDA.md.
 */
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import {
  BeliefPayloadSchema,
  SCHEMA_VERSION,
  type BeliefPayload,
  type JsonValue,
  type SignedBelief,
} from "./schema.js";

/** Sorted-keys canonical JSON. Rejects NaN/Infinity (which Zod has already filtered). */
export function canonicalJson(value: JsonValue): string {
  return encode(value);
}

function encode(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite number");
    }
    // JSON.stringify handles negative-zero and scientific notation per ES spec.
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) parts.push(encode(item));
    return "[" + parts.join(",") + "]";
  }
  // object (non-null)
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue; // undefined is not JSON; drop
    parts.push(JSON.stringify(k) + ":" + encode(v));
  }
  return "{" + parts.join(",") + "}";
}

/** UTF-8 bytes of `canonicalJson(payload)` — the exact input to sign/verify. */
export function canonicalBytes(payload: BeliefPayload): Uint8Array {
  BeliefPayloadSchema.parse(payload); // defensive: wrong shapes must never be signed
  return new TextEncoder().encode(canonicalJson(payload as JsonValue));
}

/** Content address for a belief = blake3(canonical_bytes), hex-encoded. */
export function beliefId(payload: BeliefPayload): string {
  return bytesToHex(blake3(canonicalBytes(payload)));
}

/**
 * Build a BeliefPayload with sensible defaults and server-independent fields.
 * `recorded_at` defaults to now; the caller can pin it for deterministic tests.
 */
export function buildBelief(input: {
  subject: string;
  predicate: string;
  object: JsonValue;
  signer_id: string;
  confidence?: number;
  valid_from?: string | null;
  valid_to?: string | null;
  recorded_at?: string;
  causes?: string[];
}): BeliefPayload {
  const payload: BeliefPayload = {
    schema_version: SCHEMA_VERSION,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    confidence: input.confidence ?? 1,
    valid_from: input.valid_from ?? null,
    valid_to: input.valid_to ?? null,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    signer_id: input.signer_id,
    causes: input.causes ?? [],
  };
  return BeliefPayloadSchema.parse(payload);
}

/** Strip signature + id to recover the payload shape (for re-verification). */
export function stripToPayload(signed: SignedBelief): BeliefPayload {
  const { id: _id, signature: _sig, ...payload } = signed;
  return BeliefPayloadSchema.parse(payload);
}

/**
 * NANDA AgentFacts → weavory Belief mapping.
 *
 * AgentFacts wire shape (per the NANDA spec summary in docs/NANDA.md):
 *   { agent_id, fact_type, value, valid_from?, valid_to?, signer_pubkey, signature, ... }
 *
 * We map that to a weavory belief with predicate = `agent_fact:{fact_type}`.
 * The mapping preserves all fields; a round-trip via `beliefToAgentFact` is
 * lossless for the mandatory subset.
 */
export function agentFactToBelief(fact: {
  agent_id: string;
  fact_type: string;
  value: JsonValue;
  valid_from?: string | null;
  valid_to?: string | null;
  signer_pubkey: string;
  recorded_at: string;
  confidence?: number;
  causes?: string[];
}): BeliefPayload {
  return buildBelief({
    subject: fact.agent_id,
    predicate: "agent_fact:" + fact.fact_type,
    object: fact.value,
    signer_id: fact.signer_pubkey,
    confidence: fact.confidence ?? 1,
    ...(fact.valid_from !== undefined ? { valid_from: fact.valid_from } : {}),
    ...(fact.valid_to !== undefined ? { valid_to: fact.valid_to } : {}),
    recorded_at: fact.recorded_at,
    causes: fact.causes ?? [],
  });
}

export function beliefToAgentFact(payload: BeliefPayload): {
  agent_id: string;
  fact_type: string;
  value: JsonValue;
  valid_from: string | null;
  valid_to: string | null;
  signer_pubkey: string;
  recorded_at: string;
  confidence: number;
  causes: string[];
} {
  const fact_type = payload.predicate.startsWith("agent_fact:")
    ? payload.predicate.slice("agent_fact:".length)
    : payload.predicate;
  return {
    agent_id: payload.subject,
    fact_type,
    value: payload.object,
    valid_from: payload.valid_from,
    valid_to: payload.valid_to,
    signer_pubkey: payload.signer_id,
    recorded_at: payload.recorded_at,
    confidence: payload.confidence,
    causes: payload.causes,
  };
}
