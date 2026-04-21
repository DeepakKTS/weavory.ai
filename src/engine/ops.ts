/**
 * weavory.ai — engine operations
 *
 * One function per MCP tool. All operations go through the central EngineState,
 * which handles beliefs, audit chain, trust, subscriptions, and keyring.
 *
 * Signing policy:
 *  - Clients optionally pass `signer_seed` for deterministic identity (demos).
 *    Without it, an anonymous fresh signer is allocated per call.
 *  - The server signs canonical bytes on the client's behalf. Client-side
 *    signing is a future option; not on the Phase-1 critical path.
 */
import { buildBelief } from "../core/belief.js";
import { signBelief, verifyBelief } from "../core/sign.js";
import {
  StoredBeliefSchema,
  type JsonValue,
  type StoredBelief,
} from "../core/schema.js";
import type { EngineState, SubscriptionFilters } from "./state.js";

// ---------- believe ----------

export type BelieveInput = {
  subject: string;
  predicate: string;
  object: JsonValue;
  confidence?: number;
  valid_from?: string | null;
  valid_to?: string | null;
  causes?: string[];
  signer_seed?: string;
};

export type BelieveOutput = {
  id: string;
  signer_id: string;
  entry_hash: string;
  ingested_at: string;
  audit_length: number;
};

export function believe(state: EngineState, input: BelieveInput): BelieveOutput {
  const { signer_id, keyPair } = input.signer_seed
    ? state.signerFromSeed(input.signer_seed)
    : state.freshSigner();

  const recorded_at = new Date().toISOString();

  const payload = buildBelief({
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    signer_id,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.valid_from !== undefined ? { valid_from: input.valid_from } : {}),
    ...(input.valid_to !== undefined ? { valid_to: input.valid_to } : {}),
    recorded_at,
    ...(input.causes !== undefined ? { causes: input.causes } : {}),
  });

  const signed = signBelief(payload, keyPair.privateKey);
  // Defensive: re-verify what we just signed.
  const vr = verifyBelief(signed);
  if (!vr.ok) throw new Error("internal: verify failed on freshly signed belief: " + vr.reason);

  const ingested_at = new Date().toISOString();
  const stored: StoredBelief = StoredBeliefSchema.parse({
    ...signed,
    ingested_at,
    invalidated_at: null,
    invalidated_by: null,
    quarantined: false,
    quarantine_reason: null,
  });
  state.storeBelief(stored);

  const entry = state.appendAudit({
    belief_id: stored.id,
    signer_id,
    operation: "believe",
    recorded_at: ingested_at,
  });

  return {
    id: stored.id,
    signer_id,
    entry_hash: entry.entry_hash,
    ingested_at,
    audit_length: state.audit.length(),
  };
}

// ---------- recall ----------

export type RecallInput = {
  query: string;
  top_k?: number;
  as_of?: string | null;
  min_trust?: number;
  filters?: SubscriptionFilters;
  include_quarantined?: boolean;
};

export type RecallOutput = {
  beliefs: StoredBelief[];
  total_matched: number;
  now: string;
};

const DEFAULT_MIN_TRUST = 0.3;

export function recall(state: EngineState, input: RecallInput): RecallOutput {
  const top_k = input.top_k ?? 10;
  const min_trust = input.min_trust ?? DEFAULT_MIN_TRUST;
  const now = new Date().toISOString();
  const asOf = input.as_of ?? null;
  const includeQ = input.include_quarantined ?? false;
  const q = input.query.toLowerCase();

  const matches: Array<{ belief: StoredBelief; score: number }> = [];

  for (const belief of state.beliefs.values()) {
    // Bi-temporal: if as_of is set, skip beliefs ingested after as_of or invalidated at/before as_of.
    if (asOf) {
      if (belief.ingested_at > asOf) continue;
      if (belief.invalidated_at && belief.invalidated_at <= asOf) continue;
    } else {
      // live view: skip invalidated
      if (belief.invalidated_at) continue;
    }

    // Quarantine filter.
    if (belief.quarantined && !includeQ) continue;

    // Filters.
    if (input.filters?.subject && belief.subject !== input.filters.subject) continue;
    if (input.filters?.predicate && belief.predicate !== input.filters.predicate) continue;
    if (input.filters?.min_confidence !== undefined && belief.confidence < input.filters.min_confidence) {
      continue;
    }

    // Trust gate (per-topic trust with topic = predicate).
    const t = state.trustScore(belief.signer_id, belief.predicate);
    if (t < min_trust) continue;
    if (input.filters?.min_trust !== undefined && t < input.filters.min_trust) continue;

    // Score: substring match over stringified subject/predicate/object +
    // confidence + trust. This is the placeholder for semantic embedding
    // search (W-0021) — good enough for Gate 3.
    const blob =
      belief.subject + " " + belief.predicate + " " + JSON.stringify(belief.object);
    const lower = blob.toLowerCase();
    const hits = q.length === 0 ? 1 : (lower.includes(q) ? 1 : 0);
    if (hits === 0 && q.length > 0) continue;

    const score = hits * (0.5 + 0.3 * belief.confidence + 0.2 * (t + 1) / 2);
    matches.push({ belief, score });
  }

  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, top_k).map((m) => m.belief);
  return { beliefs: top, total_matched: matches.length, now };
}

// ---------- subscribe ----------

export type SubscribeInput = {
  pattern: string;
  filters?: SubscriptionFilters;
  signer_seed?: string;
};

export type SubscribeOutput = {
  subscription_id: string;
  created_at: string;
  signer_id: string | null;
};

export function subscribe(state: EngineState, input: SubscribeInput): SubscribeOutput {
  const signer_id = input.signer_seed ? state.signerFromSeed(input.signer_seed).signer_id : null;
  const subscription_id = "sub_" + cryptoRandomId();
  const created_at = new Date().toISOString();
  state.subscriptions.set(subscription_id, {
    id: subscription_id,
    pattern: input.pattern,
    filters: input.filters ?? {},
    created_at,
    signer_id,
    matches_since_created: 0,
  });
  return { subscription_id, created_at, signer_id };
}

// ---------- attest ----------

export type AttestInput = {
  signer_id: string;
  topic: string;
  score: number;
  attestor_seed?: string;
};

export type AttestOutput = {
  signer_id: string;
  topic: string;
  applied_score: number;
  attestor_id: string;
  entry_hash: string;
  recorded_at: string;
};

export function attest(state: EngineState, input: AttestInput): AttestOutput {
  const { signer_id: attestor_id } = input.attestor_seed
    ? state.signerFromSeed(input.attestor_seed)
    : state.freshSigner();
  const applied = state.setTrust(input.signer_id, input.topic, input.score);
  const recorded_at = new Date().toISOString();
  // Attestations are recorded in the audit chain with belief_id = target signer_id for traceability.
  const entry = state.appendAudit({
    belief_id: input.signer_id,
    signer_id: attestor_id,
    operation: "attest",
    recorded_at,
  });
  return {
    signer_id: input.signer_id,
    topic: input.topic,
    applied_score: applied,
    attestor_id,
    entry_hash: entry.entry_hash,
    recorded_at,
  };
}

// ---------- forget ----------

export type ForgetInput = {
  belief_id: string;
  reason?: string;
  forgetter_seed?: string;
};

export type ForgetOutput = {
  belief_id: string;
  found: boolean;
  invalidated_at: string | null;
  entry_hash: string | null;
};

export function forget(state: EngineState, input: ForgetInput): ForgetOutput {
  const invalidated_at = new Date().toISOString();
  const { signer_id } = input.forgetter_seed
    ? state.signerFromSeed(input.forgetter_seed)
    : state.freshSigner();

  // Tombstone belief id derived from reason + id + time so forgets form their own identity.
  const tombstone_id = input.belief_id; // reuse the id; marks the belief as tombstoned
  const updated = state.tombstone(input.belief_id, tombstone_id, invalidated_at);
  if (!updated) {
    return { belief_id: input.belief_id, found: false, invalidated_at: null, entry_hash: null };
  }
  const entry = state.appendAudit({
    belief_id: input.belief_id,
    signer_id,
    operation: "forget",
    recorded_at: invalidated_at,
  });
  return {
    belief_id: input.belief_id,
    found: true,
    invalidated_at,
    entry_hash: entry.entry_hash,
  };
}

// ---------- small utilities ----------

function cryptoRandomId(): string {
  // 96-bit random, hex — plenty for local subscription identity.
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
