/**
 * weavory.ai — in-memory engine state
 *
 * One process = one State. Holds beliefs, audit chain, trust vectors, session
 * keyring, and a tiny subscription registry. This is the reference substrate
 * for Phase C; LanceDB + DuckDB persistence (W-0021/W-0022) replaces the
 * Map-backed stores in Phase G while keeping these exact method signatures.
 *
 * Determinism notes:
 *  - Server clocks are the source of `ingested_at`. The signer's `recorded_at`
 *    is what's in the signature and is preserved verbatim.
 *  - Keys derived from `signer_seed` use HKDF over SHA-256 so the same seed
 *    always produces the same signer_id (handy for two-agent demos).
 */
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import * as ed25519 from "@noble/ed25519";
import {
  type StoredBelief,
  StoredBeliefSchema,
  type AuditEntry,
} from "../core/schema.js";
import { AuditStore } from "../store/audit.js";
import { generateKeyPair, signerIdOf, type KeyPair } from "../core/sign.js";
import type { PersistentStore } from "../store/persist.js";
import type { Policy } from "./policy.js";
import { RateLimiter, parseRateLimitPerSigner } from "./rate_limit.js";

/** Phase-G-visible op names — mirrored in runtime_writer.ts. */
export type EngineOp =
  | "believe"
  | "recall"
  | "subscribe"
  | "attest"
  | "forget"
  | "startup"
  | "shutdown";

/**
 * Default subscription cap per EngineState (Phase J.P1-4 · SEC-02). A
 * defensive ceiling against a misbehaving signer registering subscriptions
 * in a hot loop. Override via `WEAVORY_MAX_SUBSCRIPTIONS=<int>`.
 *
 * Chosen at 10 000: well above any realistic agent pipeline (Phase-G demos
 * use tens of subscriptions end-to-end) while bounded enough that each
 * subscription's worst-case queue (1 000 beliefs by default) still fits in
 * reasonable memory.
 */
export const DEFAULT_MAX_SUBSCRIPTIONS = 10_000;

export function parseSubscriptionsCap(env: NodeJS.ProcessEnv): number {
  const raw = (env.WEAVORY_MAX_SUBSCRIPTIONS ?? "").trim();
  if (raw.length === 0) return DEFAULT_MAX_SUBSCRIPTIONS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    // Operator misconfiguration: fall back to default and log once.
    // Avoid throwing here — EngineState is constructed in many places.
    process.stderr.write(
      `[weavory] WEAVORY_MAX_SUBSCRIPTIONS=${JSON.stringify(raw)} ` +
        `is not a positive integer; using default ${DEFAULT_MAX_SUBSCRIPTIONS}.\n`
    );
    return DEFAULT_MAX_SUBSCRIPTIONS;
  }
  return n;
}

/** Thrown by `ops.subscribe` when `subscriptionsCap` is reached. */
export class SubscriptionLimitError extends Error {
  readonly cap: number;
  constructor(cap: number) {
    super(
      `subscribe: subscription cap reached (${cap}). ` +
        `Raise via WEAVORY_MAX_SUBSCRIPTIONS or call forget/unsubscribe flows ` +
        `(not yet exposed as MCP tool) to free slots.`
    );
    this.name = "SubscriptionLimitError";
    this.cap = cap;
  }
}

export type Subscription = {
  id: string;
  pattern: string;
  filters: SubscriptionFilters;
  created_at: string;
  signer_id: string | null; // null = anonymous / dashboard
  matches_since_created: number;
  /** Bounded FIFO of beliefs queued for this subscription; drained by recall(subscription_id). */
  queue: StoredBelief[];
  /** Max queue size; oldest dropped on overflow. */
  queue_cap: number;
  /** Count of beliefs dropped due to overflow since creation. */
  dropped_count: number;
  /** Timestamp of the last drain (via recall). */
  last_drained_at: string | null;
};

export type SubscriptionFilters = {
  subject?: string;
  predicate?: string;
  min_confidence?: number;
  min_trust?: number;
  /**
   * Phase G.5 — restricts recall to beliefs authored by this `signer_id`
   * AND attaches a `ReputationSummary` to the recall output. Hex-encoded
   * Ed25519 public key (64 chars). The filter is intentionally in this
   * block (rather than a top-level input) so it composes with the
   * existing subject/predicate filters.
   */
  reputation_of?: string;
};

export type TrustVector = Map<string /*topic*/, number /*score -1..1*/>;

/** Deterministic key derivation from a human-readable seed (demo ergonomics). */
export function deriveKeyPair(seed: string): KeyPair {
  const salt = new TextEncoder().encode("weavory/signer/v1");
  const ikm = new TextEncoder().encode(seed);
  const info = new TextEncoder().encode("ed25519-private-key");
  const privateKey = new Uint8Array(hkdf(sha256, ikm, salt, info, 32));
  // sign.ts already wired sha512Sync, so ed25519.getPublicKey is synchronous.
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

export class EngineState {
  readonly beliefs = new Map<string /*belief_id*/, StoredBelief>();
  readonly audit = new AuditStore();
  readonly trust = new Map<string /*signer_id*/, TrustVector>();
  readonly subscriptions = new Map<string /*subscription_id*/, Subscription>();
  readonly keyring = new Map<string /*signer_id*/, KeyPair>();

  /**
   * Performance index: subscriptions bucketed by their `filters.predicate`.
   * On every `believe`, we look up the bucket for the belief's predicate
   * (O(1)) plus the "any-predicate" bucket (O(K) where K = subs without a
   * predicate filter) — avoiding a linear scan across all subscriptions.
   * Kept in sync by `registerSubscription` / `unregisterSubscription`.
   */
  readonly #subsByPredicate = new Map<string /*predicate*/, Set<string /*sub_id*/>>();
  readonly #subsAnyPredicate = new Set<string /*sub_id*/>();

  /**
   * Optional post-op hook — called after each engine op mutates state.
   * Used by `RuntimeWriter` (Phase G.1) to snapshot live metrics to
   * `ops/data/runtime.json`. Never throws; the writer is responsible for
   * isolating its own errors.
   */
  onOp: ((op: EngineOp) => void) | undefined = undefined;

  /**
   * Optional persistence backend (Phase I.P0-3). When attached, every
   * mutation that changes durable state (storeBelief, tombstone, appendAudit,
   * setTrust) is mirrored to the store synchronously. When unset, state is
   * pure in-memory and behavior matches Phase-1 exactly — every existing
   * test and gate exercises that path.
   *
   * The store itself is resolved + attached by the CLI on startup based on
   * WEAVORY_PERSIST/WEAVORY_STORE/WEAVORY_DATA_DIR. Attach via
   * `attachPersist()` so a future refactor can reject double-attach or
   * add invariant checks without touching call sites.
   */
  persist: PersistentStore | undefined = undefined;

  attachPersist(store: PersistentStore): void {
    this.persist = store;
  }

  /**
   * Optional pre-believe policy (Phase I.P0-4). When attached, every
   * `believe()` call consults `evaluate(this.policy, {subject,predicate,
   * object})` before signing. Rejected requests surface a PolicyDenialError
   * to the MCP caller; allowed requests proceed as before. When unset (the
   * default), no policy evaluation happens — Phase-1 semantics are
   * preserved exactly.
   */
  policy: Policy | undefined = undefined;

  attachPolicy(p: Policy): void {
    this.policy = p;
  }

  /**
   * Rehydrate in-memory state from persisted records. Intended to be called
   * ONCE at startup, BEFORE `attachPersist`, so that replaying records does
   * not redundantly append them to disk.
   *
   * Schema-level validation already happened on the load path. We rely on
   * Map.set / AuditStore.restoreEntries here — no audit append, no persist
   * write, no subscription fan-out (there are no subscribers at startup).
   *
   * Returns a ChainVerifyResult so the caller can decide what to do with a
   * broken chain (the CLI exits non-zero; tests may tolerate).
   */
  restoreFromRecords(records: {
    beliefs: StoredBelief[];
    audit: AuditEntry[];
    trust: { signer_id: string; topic: string; score: number }[];
  }): ReturnType<AuditStore["verify"]> {
    for (const b of records.beliefs) this.beliefs.set(b.id, b);
    this.audit.restoreEntries(records.audit);
    for (const t of records.trust) {
      let vec = this.trust.get(t.signer_id);
      if (!vec) {
        vec = new Map();
        this.trust.set(t.signer_id, vec);
      }
      vec.set(t.topic, t.score);
    }
    return this.audit.verify();
  }

  /**
   * Phase G.3 — Adversarial mode (`WEAVORY_ADVERSARIAL=1`). When true, the
   * default `min_trust` used by `recall` is raised from 0.3 → 0.6 so unknown
   * signers (default neutral trust = 0.5) are hostile-until-proven-otherwise.
   * Explicit attestations still win. All other semantics (signed beliefs,
   * audit chain, quarantine flag) are unchanged — all beliefs are already
   * server-signed, so signed-lineage is enforced on every recall regardless.
   */
  adversarialMode = false;

  /**
   * Phase J.P1-4 · SEC-02 — maximum number of concurrent subscriptions
   * this state will hold. A defensive DoS cap: one misbehaving agent
   * registering subscriptions in a hot loop could otherwise exhaust memory
   * (each subscription holds a bounded queue up to 100 000 beliefs). When
   * the cap is reached, `ops.subscribe` throws `SubscriptionLimitError` and
   * no new subscription is created. Default 10 000; operators can raise or
   * lower via `WEAVORY_MAX_SUBSCRIPTIONS=<int>` in the environment.
   */
  readonly subscriptionsCap: number = parseSubscriptionsCap(process.env);

  /**
   * Phase K · SEC-07 — per-signer rate limiter applied to write operations
   * (believe, subscribe, attest, forget). Keyed on `signer_id` (the derived
   * Ed25519 public key), so the same `signer_seed` shares one bucket across
   * calls. Defaults: 100 req/sec (normal), 10 req/sec (WEAVORY_ADVERSARIAL=1).
   * Set `WEAVORY_RATE_LIMIT_PER_SIGNER=0` to disable. See rate_limit.ts.
   */
  readonly rateLimiter: RateLimiter = new RateLimiter(parseRateLimitPerSigner(process.env));

  /** Return a signer_id + keypair for a seed, caching in the keyring. */
  signerFromSeed(seed: string): { signer_id: string; keyPair: KeyPair } {
    // Derive deterministically.
    const kp = deriveKeyPair(seed);
    const signer_id = signerIdOf(kp.publicKey);
    const existing = this.keyring.get(signer_id);
    if (existing) return { signer_id, keyPair: existing };
    this.keyring.set(signer_id, kp);
    return { signer_id, keyPair: kp };
  }

  /** Allocate an anonymous, fresh signer (random key). */
  freshSigner(): { signer_id: string; keyPair: KeyPair } {
    const kp = generateKeyPair();
    const signer_id = signerIdOf(kp.publicKey);
    this.keyring.set(signer_id, kp);
    return { signer_id, keyPair: kp };
  }

  trustScore(signer_id: string, topic: string): number {
    const v = this.trust.get(signer_id);
    if (!v) return 0.5; // neutral default
    // Exact topic first, then "*" fallback.
    if (v.has(topic)) return v.get(topic)!;
    if (v.has("*")) return v.get("*")!;
    return 0.5;
  }

  setTrust(signer_id: string, topic: string, score: number): number {
    const clamped = Math.max(-1, Math.min(1, score));
    let v = this.trust.get(signer_id);
    if (!v) {
      v = new Map();
      this.trust.set(signer_id, v);
    }
    v.set(topic, clamped);
    this.persist?.writeTrust({
      signer_id,
      topic,
      score: clamped,
      recorded_at: new Date().toISOString(),
    });
    return clamped;
  }

  storeBelief(b: StoredBelief): StoredBelief {
    const parsed = StoredBeliefSchema.parse(b);
    this.beliefs.set(parsed.id, parsed);
    this.persist?.writeBelief(parsed);
    return parsed;
  }

  getBelief(id: string): StoredBelief | undefined {
    return this.beliefs.get(id);
  }

  tombstone(id: string, invalidated_by: string, invalidated_at: string): StoredBelief | null {
    const b = this.beliefs.get(id);
    if (!b) return null;
    const updated: StoredBelief = {
      ...b,
      invalidated_at,
      invalidated_by,
    };
    this.beliefs.set(id, updated);
    this.persist?.writeBelief(updated);
    return updated;
  }

  appendAudit(entry: {
    belief_id: string;
    signer_id: string;
    operation: AuditEntry["operation"];
    recorded_at: string;
  }): AuditEntry {
    const appended = this.audit.append(entry);
    this.persist?.writeAudit(appended);
    return appended;
  }

  /**
   * Register a subscription AND keep the predicate-bucket index in sync.
   * Exposed for ops.subscribe(); direct `subscriptions.set` is still allowed
   * for rehydrate / clone paths, which call `reindexSubscriptions` once at
   * the end to rebuild the index.
   */
  registerSubscription(sub: Subscription): void {
    this.subscriptions.set(sub.id, sub);
    this.#indexAddSubscription(sub);
  }

  /** Remove a subscription and deindex. (Not exposed via MCP; internal.) */
  unregisterSubscription(id: string): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;
    this.subscriptions.delete(id);
    this.#indexRemoveSubscription(sub);
    return true;
  }

  /**
   * Rebuild the predicate bucket index from `this.subscriptions`. Called by
   * `cloneState` / `replay` after they populate subscriptions directly.
   */
  reindexSubscriptions(): void {
    this.#subsByPredicate.clear();
    this.#subsAnyPredicate.clear();
    for (const sub of this.subscriptions.values()) this.#indexAddSubscription(sub);
  }

  #indexAddSubscription(sub: Subscription): void {
    const p = sub.filters.predicate;
    if (p === undefined) {
      this.#subsAnyPredicate.add(sub.id);
    } else {
      let bucket = this.#subsByPredicate.get(p);
      if (!bucket) {
        bucket = new Set();
        this.#subsByPredicate.set(p, bucket);
      }
      bucket.add(sub.id);
    }
  }

  #indexRemoveSubscription(sub: Subscription): void {
    const p = sub.filters.predicate;
    if (p === undefined) {
      this.#subsAnyPredicate.delete(sub.id);
    } else {
      const bucket = this.#subsByPredicate.get(p);
      bucket?.delete(sub.id);
      if (bucket && bucket.size === 0) this.#subsByPredicate.delete(p);
    }
  }

  /**
   * Push a newly-stored belief into every matching subscription's queue.
   * Called from `believe` after storeBelief. Match logic mirrors recall's
   * pattern/filter semantics so subscribers see the same beliefs recall would.
   * Queue is bounded; oldest entries drop when full (dropped_count increments).
   *
   * Uses `#subsByPredicate` + `#subsAnyPredicate` so the hot path is
   * `O(matching-bucket + any-pred-bucket)` instead of `O(all-subs)`.
   */
  enqueueMatches(belief: StoredBelief): void {
    const fanout = (sub: Subscription): void => {
      if (!subscriptionMatches(sub, belief)) return;
      sub.queue.push(belief);
      sub.matches_since_created += 1;
      if (sub.queue.length > sub.queue_cap) {
        const overflow = sub.queue.length - sub.queue_cap;
        sub.queue.splice(0, overflow);
        sub.dropped_count += overflow;
      }
    };

    const bucket = this.#subsByPredicate.get(belief.predicate);
    if (bucket) {
      for (const id of bucket) {
        const sub = this.subscriptions.get(id);
        if (sub) fanout(sub);
      }
    }
    for (const id of this.#subsAnyPredicate) {
      const sub = this.subscriptions.get(id);
      if (sub) fanout(sub);
    }
  }

  /**
   * Drain and return the queued beliefs for a subscription, then clear it.
   * Returns null if the subscription does not exist.
   */
  drainSubscription(
    subscription_id: string,
    now: string
  ): { delivered: StoredBelief[]; dropped_count: number } | null {
    const sub = this.subscriptions.get(subscription_id);
    if (!sub) return null;
    const delivered = sub.queue.slice();
    const dropped = sub.dropped_count;
    sub.queue.length = 0;
    sub.dropped_count = 0;
    sub.last_drained_at = now;
    return { delivered, dropped_count: dropped };
  }
}

/** Shared predicate used by both `enqueueMatches` and recall's query branch. */
export function subscriptionMatches(sub: Subscription, belief: StoredBelief): boolean {
  // Filters first (cheap checks).
  if (sub.filters.subject && belief.subject !== sub.filters.subject) return false;
  if (sub.filters.predicate && belief.predicate !== sub.filters.predicate) return false;
  if (
    sub.filters.min_confidence !== undefined &&
    belief.confidence < sub.filters.min_confidence
  ) {
    return false;
  }
  // Pattern is whitespace-tokenized — every non-empty token must appear as a
  // substring in subject / predicate / JSON.stringify(object) — AND semantics,
  // case-insensitive. Empty or whitespace-only pattern matches everything
  // passing the filters. Mirrors recall()'s query logic in src/engine/ops.ts
  // (v0.1.9 token-AND upgrade) so subscribers see the same beliefs a recall
  // with the same pattern-as-query would return.
  //
  // Perf: object blob is JSON-stringified lazily, only for tokens that didn't
  // already match the small subject / predicate strings.
  const p = sub.pattern.toLowerCase();
  if (p.length === 0) return true;
  const tokens = p.split(/\s+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  const subjLc = belief.subject.toLowerCase();
  const predLc = belief.predicate.toLowerCase();
  let objStrLc: string | null = null;
  for (const tok of tokens) {
    if (subjLc.includes(tok) || predLc.includes(tok)) continue;
    if (objStrLc === null) objStrLc = JSON.stringify(belief.object).toLowerCase();
    if (!objStrLc.includes(tok)) return false;
  }
  return true;
}
