/**
 * Integration tests — full engine flow end-to-end.
 *
 * Covers:
 *  - T-I-001 two-agent belief exchange (Gate 3 prerequisite)
 *  - T-S-004 OR-set tombstone respected by live recall
 *  - T-T-001..T-T-003 trust gating
 *  - T-I-003 as_of bi-temporal recall (Gate 5 prerequisite)
 */
import { describe, it, expect } from "vitest";
import { verifyBelief } from "../../src/core/sign.js";
import { EngineState } from "../../src/engine/state.js";
import { attest, believe, forget, recall } from "../../src/engine/ops.js";

describe("two-agent belief exchange (T-I-001)", () => {
  it("alice writes; bob recalls in the same engine", () => {
    const s = new EngineState();

    const out = believe(s, {
      subject: "weather:cambridge",
      predicate: "observation",
      object: { temperature_c: 12, cloudy: true },
      signer_seed: "alice",
    });
    expect(out.id).toMatch(/^[0-9a-f]{64}$/);
    expect(out.signer_id).toMatch(/^[0-9a-f]{64}$/);
    expect(out.audit_length).toBe(1);

    // Bob's recall, but first bob must trust alice or the default trust gate blocks.
    attest(s, { signer_id: out.signer_id, topic: "observation", score: 0.8, attestor_seed: "bob" });

    const r = recall(s, { query: "cambridge", top_k: 5 });
    expect(r.total_matched).toBe(1);
    expect(r.beliefs).toHaveLength(1);
    expect(r.beliefs[0].subject).toBe("weather:cambridge");

    // Bob can verify Alice's signature independently.
    const { id: _id, signature: _sig, ...rest } = r.beliefs[0];
    const payloadOnly = { ...rest } as Parameters<typeof verifyBelief>[0];
    // The StoredBelief includes ingested_at/invalidated_* which are NOT part of the signed payload.
    // We re-verify the SignedBelief that was stored by using id + signature round-trip via the Stored record.
    const verified = verifyBelief({
      id: r.beliefs[0].id,
      signature: r.beliefs[0].signature,
      schema_version: r.beliefs[0].schema_version,
      subject: r.beliefs[0].subject,
      predicate: r.beliefs[0].predicate,
      object: r.beliefs[0].object,
      confidence: r.beliefs[0].confidence,
      valid_from: r.beliefs[0].valid_from,
      valid_to: r.beliefs[0].valid_to,
      recorded_at: r.beliefs[0].recorded_at,
      signer_id: r.beliefs[0].signer_id,
      causes: r.beliefs[0].causes,
    });
    expect(verified.ok).toBe(true);
  });

  it("same signer_seed yields the same signer_id (deterministic identity)", () => {
    const s = new EngineState();
    const a1 = believe(s, { subject: "x", predicate: "p", object: 1, signer_seed: "alice" });
    const a2 = believe(s, { subject: "y", predicate: "p", object: 2, signer_seed: "alice" });
    expect(a1.signer_id).toBe(a2.signer_id);

    const b = believe(s, { subject: "z", predicate: "p", object: 3, signer_seed: "bob" });
    expect(b.signer_id).not.toBe(a1.signer_id);
  });
});

describe("recall filters and trust gating (T-T-001, T-T-003)", () => {
  it("default min_trust hides untrusted signers until an attestation raises them", () => {
    const s = new EngineState();
    const w = believe(s, {
      subject: "market:AAPL",
      predicate: "rumor",
      object: "pop",
      signer_seed: "rando",
    });

    // Without attestation, default trust (0.5) for rando is ABOVE default min_trust (0.3) → visible.
    let r = recall(s, { query: "market" });
    expect(r.total_matched).toBe(1);

    // Drop trust below threshold → filtered.
    attest(s, { signer_id: w.signer_id, topic: "rumor", score: -0.5 });
    r = recall(s, { query: "market" });
    expect(r.total_matched).toBe(0);

    // Raise threshold of caller: now need min_trust=0.9, attestation at 0.8 still blocks.
    attest(s, { signer_id: w.signer_id, topic: "rumor", score: 0.8 });
    r = recall(s, { query: "market", min_trust: 0.9 });
    expect(r.total_matched).toBe(0);

    r = recall(s, { query: "market", min_trust: 0.5 });
    expect(r.total_matched).toBe(1);
  });
});

describe("forget + as_of bi-temporal recall (T-S-004, T-I-003)", () => {
  it("forget hides beliefs from live view but as_of past still sees them", async () => {
    const s = new EngineState();
    const w = believe(s, {
      subject: "agent:alice",
      predicate: "knows",
      object: "secret handshake",
      signer_seed: "alice",
    });
    attest(s, { signer_id: w.signer_id, topic: "knows", score: 0.7 });

    // Capture a timestamp while the belief is live.
    const t_before_forget = new Date().toISOString();
    // Nudge the clock so subsequent events have distinct ISO-8601 timestamps.
    await new Promise((r) => setTimeout(r, 5));

    const f = forget(s, { belief_id: w.id });
    expect(f.found).toBe(true);
    expect(f.invalidated_at).not.toBeNull();

    // Live view: hidden.
    const live = recall(s, { query: "secret" });
    expect(live.total_matched).toBe(0);

    // as_of before forget: visible.
    const past = recall(s, { query: "secret", as_of: t_before_forget });
    expect(past.total_matched).toBe(1);
    expect(past.beliefs[0].invalidated_at).not.toBeNull();
  });
});

describe("audit chain grows append-only across operations", () => {
  it("believe, attest, forget each append an entry; chain verifies", () => {
    const s = new EngineState();
    const b = believe(s, { subject: "s", predicate: "p", object: "o", signer_seed: "alice" });
    expect(s.audit.length()).toBe(1);

    attest(s, { signer_id: b.signer_id, topic: "p", score: 0.9 });
    expect(s.audit.length()).toBe(2);

    const f = forget(s, { belief_id: b.id });
    expect(f.found).toBe(true);
    expect(s.audit.length()).toBe(3);

    const vr = s.audit.verify();
    expect(vr.ok).toBe(true);
    if (vr.ok) expect(vr.length).toBe(3);
  });
});
