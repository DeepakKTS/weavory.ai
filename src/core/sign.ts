/**
 * weavory.ai — Ed25519 sign / verify
 *
 * Keys are 32-byte Ed25519 pairs (@noble/ed25519 v2). The public key, hex
 * encoded, is the agent's `signer_id`. Signatures are over the canonical
 * JSON bytes of the belief payload (see `belief.ts`).
 *
 * Security notes:
 *  - `verify` is constant-time with respect to the signature/key via @noble.
 *  - Tamper detection: any change to payload → different canonical bytes →
 *    verify returns false.
 *  - Private keys are held by callers; this module never persists them.
 */
import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import { canonicalBytes, stripToPayload, beliefId } from "./belief.js";
import { SignedBeliefSchema, type BeliefPayload, type SignedBelief } from "./schema.js";

// @noble/ed25519 v2 requires a synchronous sha512 for sync sign / verify.
// Wire @noble/hashes' sha512 so sync APIs work on Node 20+ without WebCrypto.
ed25519.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const total = messages.reduce((n, m) => n + m.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const m of messages) {
    joined.set(m, off);
    off += m.length;
  }
  return sha512(joined);
};

export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

/** Generate a fresh Ed25519 key pair. Private key MUST be treated as a secret. */
export function generateKeyPair(): KeyPair {
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** `signer_id` (hex) → 32-byte public key bytes. Throws on malformed input. */
export function parseSignerId(signerId: string): Uint8Array {
  const b = hexToBytes(signerId);
  if (b.length !== 32) throw new Error("signer_id must decode to 32 bytes");
  return b;
}

/** Sign a BeliefPayload and produce a content-addressed SignedBelief. */
export function signBelief(payload: BeliefPayload, privateKey: Uint8Array): SignedBelief {
  if (privateKey.length !== 32) throw new Error("privateKey must be 32 bytes");
  const bytes = canonicalBytes(payload);
  const signatureBytes = ed25519.sign(bytes, privateKey);
  const id = beliefId(payload);
  const signed: SignedBelief = {
    ...payload,
    id,
    signature: bytesToHex(signatureBytes),
  };
  return SignedBeliefSchema.parse(signed);
}

/** Verification result — failure type is explicit so callers can branch cleanly. */
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "id_mismatch" | "bad_signature" | "schema" };

/**
 * Verify a SignedBelief: payload shape is valid, id matches canonical hash,
 * signature is valid for `signer_id`.
 */
export function verifyBelief(signed: SignedBelief): VerifyResult {
  const parsed = SignedBeliefSchema.safeParse(signed);
  if (!parsed.success) return { ok: false, reason: "schema" };

  const payload = stripToPayload(parsed.data);
  const expectedId = beliefId(payload);
  if (expectedId !== parsed.data.id) return { ok: false, reason: "id_mismatch" };

  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(parsed.data.signature);
    pubBytes = parseSignerId(parsed.data.signer_id);
  } catch {
    return { ok: false, reason: "schema" };
  }

  const bytes = canonicalBytes(payload);
  const ok = ed25519.verify(sigBytes, bytes, pubBytes);
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** Hex-encode a public key for use as `signer_id`. */
export function signerIdOf(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("publicKey must be 32 bytes");
  return bytesToHex(publicKey);
}
