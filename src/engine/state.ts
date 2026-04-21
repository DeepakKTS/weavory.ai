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

export type Subscription = {
  id: string;
  pattern: string;
  filters: SubscriptionFilters;
  created_at: string;
  signer_id: string | null; // null = anonymous / dashboard
  matches_since_created: number;
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
}
