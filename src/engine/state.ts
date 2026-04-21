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

/** Phase-G-visible op names — mirrored in runtime_writer.ts. */
export type EngineOp =
  | "believe"
  | "recall"
  | "subscribe"
  | "attest"
  | "forget"
  | "startup"
  | "shutdown";

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
   * Optional post-op hook — called after each engine op mutates state.
   * Used by `RuntimeWriter` (Phase G.1) to snapshot live metrics to
   * `ops/data/runtime.json`. Never throws; the writer is responsible for
   * isolating its own errors.
   */
  onOp: ((op: EngineOp) => void) | undefined = undefined;

  /**
   * Phase G.3 — Adversarial mode (`WEAVORY_ADVERSARIAL=1`). When true, the
   * default `min_trust` used by `recall` is raised from 0.3 → 0.6 so unknown
   * signers (default neutral trust = 0.5) are hostile-until-proven-otherwise.
   * Explicit attestations still win. All other semantics (signed beliefs,
   * audit chain, quarantine flag) are unchanged — all beliefs are already
   * server-signed, so signed-lineage is enforced on every recall regardless.
   */
  adversarialMode = false;

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
    return clamped;
  }

  storeBelief(b: StoredBelief): StoredBelief {
    const parsed = StoredBeliefSchema.parse(b);
    this.beliefs.set(parsed.id, parsed);
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
    return updated;
  }

  appendAudit(entry: {
    belief_id: string;
    signer_id: string;
    operation: AuditEntry["operation"];
    recorded_at: string;
  }): AuditEntry {
    return this.audit.append(entry);
  }

  /**
   * Push a newly-stored belief into every matching subscription's queue.
   * Called from `believe` after storeBelief. Match logic mirrors recall's
   * pattern/filter semantics so subscribers see the same beliefs recall would.
   * Queue is bounded; oldest entries drop when full (dropped_count increments).
   */
  enqueueMatches(belief: StoredBelief): void {
    for (const sub of this.subscriptions.values()) {
      if (!subscriptionMatches(sub, belief)) continue;
      sub.queue.push(belief);
      sub.matches_since_created += 1;
      if (sub.queue.length > sub.queue_cap) {
        const overflow = sub.queue.length - sub.queue_cap;
        sub.queue.splice(0, overflow);
        sub.dropped_count += overflow;
      }
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
  // Pattern is a case-insensitive substring over subject/predicate/object.
  // Empty pattern matches everything passing the filters.
  const p = sub.pattern.toLowerCase();
  if (p.length === 0) return true;
  const blob = (
    belief.subject +
    " " +
    belief.predicate +
    " " +
    JSON.stringify(belief.object)
  ).toLowerCase();
  return blob.includes(p);
}
