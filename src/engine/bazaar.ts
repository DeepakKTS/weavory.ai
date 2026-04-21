/**
 * weavory.ai — The Bazaar (Phase G.5)
 *
 * Pure helpers for three trading primitives that ride on top of the existing
 * five-tool MCP surface — no new tools, no new schema at the wire edge.
 * Everything below is derived from existing beliefs + trust vectors.
 *
 *   W-0140 `getReputation(state, signer_id)`
 *     Aggregates a signer's attested trust across topics plus authorship
 *     statistics into a single summary. `recall` attaches this summary
 *     when `filters.reputation_of` is set.
 *
 *   W-0141 `findCapabilities(state, name?)`
 *     Convention: a belief with predicate `"capability.offers"` is an ad.
 *     This helper surfaces them, optionally filtered by `object.name`.
 *
 *   W-0142 (next commit) `walkEscrowThread` + `isEscrowSettled`
 *     Using the existing `causes[]` field to traverse a four-stage
 *     escrow: capability.offers → escrow.payment → escrow.delivered →
 *     escrow.settled.
 */
import type { EngineState } from "./state.js";
import type { JsonValue, StoredBelief } from "../core/schema.js";

// ---------- W-0140 reputation ----------

export type ReputationSummary = {
  signer_id: string;
  /** Sorted alphabetically by topic for deterministic output. */
  topics: Array<{ topic: string; score: number }>;
  /** Mean of all topic scores. 0 when `attestation_count === 0`. */
  avg_trust: number;
  /** Number of distinct topics with an explicit trust entry. */
  attestation_count: number;
  /** Total beliefs whose `signer_id` matches this signer (alive or tombstoned). */
  beliefs_authored: number;
  /** Authored beliefs that are still live (not tombstoned). */
  beliefs_live: number;
  /** Authored beliefs that have been tombstoned. */
  beliefs_tombstoned: number;
};

export function getReputation(state: EngineState, signer_id: string): ReputationSummary {
  const trust = state.trust.get(signer_id);
  const topics: Array<{ topic: string; score: number }> = [];
  let total = 0;
  if (trust) {
    for (const [topic, score] of trust) topics.push({ topic, score });
    topics.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
    for (const t of topics) total += t.score;
  }
  const attestation_count = topics.length;
  const avg_trust = attestation_count === 0 ? 0 : total / attestation_count;

  let beliefs_authored = 0;
  let beliefs_live = 0;
  let beliefs_tombstoned = 0;
  for (const b of state.beliefs.values()) {
    if (b.signer_id !== signer_id) continue;
    beliefs_authored++;
    if (b.invalidated_at) beliefs_tombstoned++;
    else beliefs_live++;
  }

  return {
    signer_id,
    topics,
    avg_trust,
    attestation_count,
    beliefs_authored,
    beliefs_live,
    beliefs_tombstoned,
  };
}

// ---------- W-0141 capability offers ----------

export const CAPABILITY_OFFERS_PREDICATE = "capability.offers" as const;

export type CapabilityOffer = {
  offer_id: string;
  signer_id: string;
  subject: string;
  capability: JsonValue;
  recorded_at: string;
  ingested_at: string;
  confidence: number;
  /** true if the underlying belief has been tombstoned. */
  withdrawn: boolean;
};

/**
 * Enumerate every `capability.offers` belief in the state. When `name` is
 * provided, filter to offers whose `object.name` equals that value (the
 * Bazaar convention for capability identity). Returns offers sorted by
 * `recorded_at` descending so the freshest ads come first.
 */
export function findCapabilities(state: EngineState, name?: string): CapabilityOffer[] {
  const out: CapabilityOffer[] = [];
  for (const b of state.beliefs.values()) {
    if (b.predicate !== CAPABILITY_OFFERS_PREDICATE) continue;
    if (name !== undefined) {
      const objName =
        typeof b.object === "object" && b.object !== null && !Array.isArray(b.object)
          ? (b.object as Record<string, JsonValue>).name
          : undefined;
      if (objName !== name) continue;
    }
    out.push({
      offer_id: b.id,
      signer_id: b.signer_id,
      subject: b.subject,
      capability: b.object,
      recorded_at: b.recorded_at,
      ingested_at: b.ingested_at,
      confidence: b.confidence,
      withdrawn: Boolean(b.invalidated_at),
    });
  }
  out.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0));
  return out;
}

// ---------- internal: belief lookup ----------

/** Used by escrow walker (next commit) and by recall's reputation branch. */
export function beliefsAuthoredBy(state: EngineState, signer_id: string): StoredBelief[] {
  const out: StoredBelief[] = [];
  for (const b of state.beliefs.values()) {
    if (b.signer_id === signer_id) out.push(b);
  }
  return out;
}
