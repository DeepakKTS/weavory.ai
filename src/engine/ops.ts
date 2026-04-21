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
import { mergeConflicts, type ConflictGroup, type MergeStrategy } from "./merge.js";

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

  // Phase G.2: fan out to matching subscriptions. Happens after storeBelief
  // so subscribers never see a belief that isn't also durably stored.
  state.enqueueMatches(stored);
  state.onOp?.("believe");
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
  /**
   * Phase G.2 — if set, recall drains the subscription queue instead of
   * scanning all beliefs. All other filters still apply to the drained set.
   * Returns `delivered_count` and `dropped_count` in addition to beliefs.
   */
  subscription_id?: string;
  /**
   * Phase G.2 — conflict visibility.
   *   undefined / false → collapse conflicting beliefs to a single winner per
   *     the chosen merge_strategy (default: "consensus"). Default behavior,
   *     preserves Gate 3/4/5 semantics.
   *   true → include conflicts[] in the output so the caller can render
   *     disagreement. The main beliefs[] list still contains merged winners.
   */
  include_conflicts?: boolean;
  /** Phase G.2 — merge strategy for conflicting beliefs. Default "consensus". */
  merge_strategy?: MergeStrategy;
};

export type RecallOutput = {
  beliefs: StoredBelief[];
  total_matched: number;
  now: string;
  /** Populated when `subscription_id` was provided on input. */
  delivered_count?: number;
  dropped_count?: number;
  subscription_id?: string;
  /** Phase G.2 — present iff include_conflicts=true AND conflicts were found. */
  conflicts?: ConflictGroup[];
  /** Phase G.2 — the merge strategy actually applied this call. */
  merge_strategy?: MergeStrategy;
};

const DEFAULT_MIN_TRUST = 0.3;

export function recall(state: EngineState, input: RecallInput): RecallOutput {
  const top_k = input.top_k ?? 10;
  const min_trust = input.min_trust ?? DEFAULT_MIN_TRUST;
  const now = new Date().toISOString();
  const asOf = input.as_of ?? null;
  const includeQ = input.include_quarantined ?? false;
  const q = input.query.toLowerCase();

  // Phase G.2 — subscription drain branch.
  // When subscription_id is provided, the source of candidates is the
  // subscription's queue rather than state.beliefs. All other filters
  // (as_of, min_trust, quarantine, filters, query) still apply — this lets
  // a subscriber say "drain what still matches my current criteria".
  let queuedSource: StoredBelief[] | null = null;
  let dropped_count = 0;
  if (input.subscription_id !== undefined) {
    const drained = state.drainSubscription(input.subscription_id, now);
    if (drained) {
      queuedSource = drained.delivered;
      dropped_count = drained.dropped_count;
    } else {
      queuedSource = [];
    }
  }

  const candidates: Iterable<StoredBelief> = queuedSource ?? state.beliefs.values();
  const matches: Array<{ belief: StoredBelief; score: number }> = [];

  for (const belief of candidates) {
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

  // Phase G.2 — conflict detection + optional merge.
  //
  // Default behavior (no merge_strategy set): return ALL matching beliefs
  // including conflicting variants. This preserves Gate 4 (adversarial view)
  // and every previously-green path. Callers who want a single merged answer
  // opt in via `merge_strategy: "consensus"` or `"lww"`.
  //
  // `include_conflicts: true` ALWAYS surfaces conflicting groups in the
  // output for introspection — orthogonal to merging. Skipped for as_of
  // queries so historians see the raw record.
  const trustLookup = (signer_id: string, topic: string): number =>
    state.trustScore(signer_id, topic);

  let effectiveMatches = matches;
  let conflicts: ConflictGroup[] = [];
  let appliedStrategy: MergeStrategy | undefined;

  if (!asOf && (input.merge_strategy !== undefined || input.include_conflicts)) {
    const rankedBeliefs = matches.map((m) => m.belief);
    const strategy: MergeStrategy = input.merge_strategy ?? "consensus";
    const merge = mergeConflicts(rankedBeliefs, trustLookup, strategy);
    conflicts = merge.conflicts;

    if (input.merge_strategy !== undefined) {
      // Collapse to winners — preserving the original rank order.
      const mergedSet = new Set(merge.merged.map((b) => b.id));
      effectiveMatches = matches.filter((m) => mergedSet.has(m.belief.id));
      appliedStrategy = strategy;
    }
    // If include_conflicts alone, leave effectiveMatches untouched (show all variants).
  }

  const top = effectiveMatches.slice(0, top_k).map((m) => m.belief);
  state.onOp?.("recall");
  const out: RecallOutput = {
    beliefs: top,
    total_matched: effectiveMatches.length,
    now,
  };
  if (appliedStrategy !== undefined) out.merge_strategy = appliedStrategy;
  if (input.subscription_id !== undefined) {
    out.subscription_id = input.subscription_id;
    out.delivered_count = top.length;
    out.dropped_count = dropped_count;
  }
  if (input.include_conflicts && conflicts.length > 0) {
    out.conflicts = conflicts;
  }
  return out;
}

// ---------- subscribe ----------

export type SubscribeInput = {
  pattern: string;
  filters?: SubscriptionFilters;
  signer_seed?: string;
  /** Max queued beliefs per subscription; oldest dropped on overflow. Default 1000. */
  queue_cap?: number;
};

export type SubscribeOutput = {
  subscription_id: string;
  created_at: string;
  signer_id: string | null;
  queue_cap: number;
};

const DEFAULT_SUBSCRIPTION_QUEUE_CAP = 1000;

export function subscribe(state: EngineState, input: SubscribeInput): SubscribeOutput {
  const signer_id = input.signer_seed ? state.signerFromSeed(input.signer_seed).signer_id : null;
  const subscription_id = "sub_" + cryptoRandomId();
  const created_at = new Date().toISOString();
  const queue_cap = Math.max(1, input.queue_cap ?? DEFAULT_SUBSCRIPTION_QUEUE_CAP);
  state.subscriptions.set(subscription_id, {
    id: subscription_id,
    pattern: input.pattern,
    filters: input.filters ?? {},
    created_at,
    signer_id,
    matches_since_created: 0,
    queue: [],
    queue_cap,
    dropped_count: 0,
    last_drained_at: null,
  });
  state.onOp?.("subscribe");
  return { subscription_id, created_at, signer_id, queue_cap };
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
  state.onOp?.("attest");
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
  state.onOp?.("forget");
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
