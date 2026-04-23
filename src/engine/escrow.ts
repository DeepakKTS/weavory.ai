/**
 * weavory.ai — escrow marketplace & reputation (Phase G.5)
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
 * escrow convention for capability identity). Returns offers sorted by
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

/** Used by escrow walker and by recall's reputation branch. */
export function beliefsAuthoredBy(state: EngineState, signer_id: string): StoredBelief[] {
  const out: StoredBelief[] = [];
  for (const b of state.beliefs.values()) {
    if (b.signer_id === signer_id) out.push(b);
  }
  return out;
}

// ---------- W-0142 escrow thread walker ----------

/**
 * Escrow stage machine, keyed by `predicate`:
 *
 *   capability.offers   (offer)      — posted by seller
 *   escrow.payment      (payment)    — posted by buyer; causes: [offer]
 *   escrow.delivered    (delivered)  — posted by seller; causes: [payment]
 *   escrow.settled      (settled)    — posted by buyer; causes: [delivered]
 *                                      object.outcome: "accepted" | "disputed"
 *
 * `walkEscrowThread(state, root_id)` returns the root + every belief that
 * causally descends from it via the `causes[]` field, stage-tagged.
 */
export const ESCROW_PAYMENT_PREDICATE = "escrow.payment" as const;
export const ESCROW_DELIVERED_PREDICATE = "escrow.delivered" as const;
export const ESCROW_SETTLED_PREDICATE = "escrow.settled" as const;

export type EscrowStage =
  | "offer"
  | "payment"
  | "delivered"
  | "settled"
  | "other";

export type EscrowStep = {
  belief_id: string;
  stage: EscrowStage;
  signer_id: string;
  subject: string;
  recorded_at: string;
  causes: string[];
  object: JsonValue;
  invalidated_at: string | null;
};

function stageOf(predicate: string): EscrowStage {
  switch (predicate) {
    case CAPABILITY_OFFERS_PREDICATE:
      return "offer";
    case ESCROW_PAYMENT_PREDICATE:
      return "payment";
    case ESCROW_DELIVERED_PREDICATE:
      return "delivered";
    case ESCROW_SETTLED_PREDICATE:
      return "settled";
    default:
      return "other";
  }
}

function toStep(belief: StoredBelief): EscrowStep {
  return {
    belief_id: belief.id,
    stage: stageOf(belief.predicate),
    signer_id: belief.signer_id,
    subject: belief.subject,
    recorded_at: belief.recorded_at,
    causes: [...belief.causes],
    object: belief.object,
    invalidated_at: belief.invalidated_at,
  };
}

/**
 * Breadth-first traversal of the causal graph starting at `root_id`.
 * Returns the root belief plus every belief whose `causes[]` transitively
 * lists it. Children within a level are sorted by `recorded_at` so the
 * output is deterministic even when multiple publishes happen in the
 * same millisecond.
 */
export function walkEscrowThread(state: EngineState, root_id: string): EscrowStep[] {
  const root = state.beliefs.get(root_id);
  if (!root) return [];

  // Build a one-pass parent → children index. O(beliefs + causes).
  const childrenOf = new Map<string, StoredBelief[]>();
  for (const b of state.beliefs.values()) {
    for (const parent of b.causes) {
      let arr = childrenOf.get(parent);
      if (!arr) {
        arr = [];
        childrenOf.set(parent, arr);
      }
      arr.push(b);
    }
  }

  const out: EscrowStep[] = [toStep(root)];
  const seen = new Set<string>([root_id]);
  const queue: string[] = [root_id];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const kids = childrenOf.get(current);
    if (!kids) continue;
    kids.sort((a, b) =>
      a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : a.id.localeCompare(b.id)
    );
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      out.push(toStep(k));
      queue.push(k.id);
    }
  }
  return out;
}

export type EscrowOutcome = "accepted" | "disputed" | null;

export type EscrowStatus = {
  root_id: string;
  steps: EscrowStep[];
  has_offer: boolean;
  has_payment: boolean;
  has_delivered: boolean;
  has_settled: boolean;
  settled: boolean; // true iff at least one settled step has outcome="accepted"
  outcome: EscrowOutcome; // the outcome of the (latest) settled step, if any
};

/** Aggregate view over `walkEscrowThread` plus outcome extraction. */
export function escrowStatus(state: EngineState, root_id: string): EscrowStatus {
  const steps = walkEscrowThread(state, root_id);
  const status: EscrowStatus = {
    root_id,
    steps,
    has_offer: false,
    has_payment: false,
    has_delivered: false,
    has_settled: false,
    settled: false,
    outcome: null,
  };
  let latestSettled: EscrowStep | null = null;
  for (const s of steps) {
    if (s.stage === "offer") status.has_offer = true;
    if (s.stage === "payment") status.has_payment = true;
    if (s.stage === "delivered") status.has_delivered = true;
    if (s.stage === "settled") {
      status.has_settled = true;
      if (
        latestSettled === null ||
        s.recorded_at > latestSettled.recorded_at ||
        (s.recorded_at === latestSettled.recorded_at && s.belief_id > latestSettled.belief_id)
      ) {
        latestSettled = s;
      }
    }
  }
  if (latestSettled) {
    const obj = latestSettled.object;
    const outcome =
      typeof obj === "object" && obj !== null && !Array.isArray(obj)
        ? (obj as Record<string, JsonValue>).outcome
        : null;
    if (outcome === "accepted") {
      status.outcome = "accepted";
      status.settled = true;
    } else if (outcome === "disputed") {
      status.outcome = "disputed";
    }
  }
  return status;
}

/** Shorthand: did this escrow reach a settled step with outcome="accepted"? */
export function isEscrowSettled(state: EngineState, root_id: string): boolean {
  return escrowStatus(state, root_id).settled;
}
