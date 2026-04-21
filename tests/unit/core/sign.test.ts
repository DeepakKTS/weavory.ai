/**
 * Unit tests — src/core/sign.ts
 *
 * Covers TEST_MATRIX entries T-C-003 (round-trip), T-C-004 (tamper detection).
 */
import { describe, it, expect } from "vitest";
import { bytesToHex } from "@noble/hashes/utils";
import { buildBelief } from "../../../src/core/belief.js";
import {
  generateKeyPair,
  parseSignerId,
  signBelief,
  signerIdOf,
  verifyBelief,
} from "../../../src/core/sign.js";
import type { SignedBelief } from "../../../src/core/schema.js";

describe("key generation", () => {
  it("produces 32-byte public/private keys", () => {
    const kp = generateKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it("signerIdOf round-trips via parseSignerId", () => {
    const kp = generateKeyPair();
    const id = signerIdOf(kp.publicKey);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(bytesToHex(parseSignerId(id))).toBe(id);
  });
});

describe("signBelief + verifyBelief (T-C-003, T-C-004)", () => {
  const kp = generateKeyPair();
  const signer_id = signerIdOf(kp.publicKey);

  const payload = buildBelief({
    subject: "agent:alice",
    predicate: "knows",
    object: { fact: "the sky is blue" },
    signer_id,
    recorded_at: "2026-04-21T20:00:00Z",
  });

  it("round-trip sign → verify returns ok (T-C-003)", () => {
    const signed = signBelief(payload, kp.privateKey);
    const r = verifyBelief(signed);
    expect(r.ok).toBe(true);
  });

  it("verify rejects a tampered object (T-C-004)", () => {
    const signed = signBelief(payload, kp.privateKey);
    const tampered: SignedBelief = { ...signed, object: { fact: "the sky is green" } };
    const r = verifyBelief(tampered);
    expect(r.ok).toBe(false);
    // Tampering the object changes canonical bytes → id recomputes differently →
    // id mismatch is detected *before* the signature check.
    if (!r.ok) expect(r.reason).toBe("id_mismatch");
  });

  it("verify rejects a tampered signature", () => {
    const signed = signBelief(payload, kp.privateKey);
    const badSig =
      signed.signature.slice(0, -2) +
      (signed.signature.endsWith("00") ? "01" : "00");
    const r = verifyBelief({ ...signed, signature: badSig });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("verify rejects a belief from a different signer", () => {
    const other = generateKeyPair();
    const signed = signBelief(payload, other.privateKey); // signed by other.priv but signer_id points at kp.pub
    const r = verifyBelief(signed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("two identical payloads produce the same id", () => {
    const s1 = signBelief(payload, kp.privateKey);
    const s2 = signBelief(payload, kp.privateKey);
    expect(s1.id).toBe(s2.id);
    // Signatures may differ per call (Ed25519 is deterministic, so they won't — but we don't depend on it).
  });

  it("parseSignerId rejects wrong length", () => {
    expect(() => parseSignerId("abcd")).toThrow();
  });
});
