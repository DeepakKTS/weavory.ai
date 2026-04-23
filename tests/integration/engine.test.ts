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

describe("recall include_tombstoned flag (v0.1.10)", () => {
  it("default recall hides tombstoned beliefs; include_tombstoned: true surfaces them", () => {
    const s = new EngineState();
    const out = believe(s, {
      subject: "ephemeral/x",
      predicate: "status",
      object: "live",
      signer_seed: "tomb-test",
    });
    s.setTrust(out.signer_id, "status", 0.9);

    forget(s, { belief_id: out.id, forgetter_seed: "tomb-test" });

    const liveDefault = recall(s, { query: "", min_trust: -1 });
    expect(liveDefault.total_matched).toBe(0);

    const liveWithTomb = recall(s, { query: "", min_trust: -1, include_tombstoned: true });
    expect(liveWithTomb.total_matched).toBe(1);
    expect(liveWithTomb.beliefs[0].invalidated_at).not.toBeNull();
    expect(liveWithTomb.beliefs[0].id).toBe(out.id);
  });

  it("include_tombstoned + include_quarantined are orthogonal — both flags stack", () => {
    const s = new EngineState();
    const b = believe(s, {
      subject: "q/1",
      predicate: "p",
      object: "x",
      signer_seed: "both",
    });
    s.setTrust(b.signer_id, "p", 0.9);
    // Mark as quarantined via the engine internal API (matches tamper scan behavior).
    const stored = s.beliefs.get(b.id)!;
    s.beliefs.set(b.id, { ...stored, quarantined: true, quarantine_reason: "test" });
    forget(s, { belief_id: b.id, forgetter_seed: "both" });

    // Default recall: quarantined AND tombstoned → doubly hidden.
    expect(recall(s, { query: "", min_trust: -1 }).total_matched).toBe(0);
    // Only one flag lifts only one filter.
    expect(recall(s, { query: "", min_trust: -1, include_quarantined: true }).total_matched).toBe(0);
    expect(recall(s, { query: "", min_trust: -1, include_tombstoned: true }).total_matched).toBe(0);
    // Both flags → surfaced.
    const all = recall(s, {
      query: "",
      min_trust: -1,
      include_quarantined: true,
      include_tombstoned: true,
    });
    expect(all.total_matched).toBe(1);
    expect(all.beliefs[0].invalidated_at).not.toBeNull();
    expect(all.beliefs[0].quarantined).toBe(true);
  });

  it("as_of branch ignores include_tombstoned (bi-temporal governs)", async () => {
    const s = new EngineState();
    const out = believe(s, {
      subject: "as-of/x",
      predicate: "p",
      object: "v",
      signer_seed: "as-of-test",
    });
    s.setTrust(out.signer_id, "p", 0.9);

    const tPre = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    forget(s, { belief_id: out.id, forgetter_seed: "as-of-test" });

    // as_of before the forget — belief visible regardless of include_tombstoned.
    expect(recall(s, { query: "", as_of: tPre, min_trust: -1 }).total_matched).toBe(1);
    expect(
      recall(s, { query: "", as_of: tPre, min_trust: -1, include_tombstoned: true }).total_matched
    ).toBe(1);
  });
});

describe("recall query uses token-AND substring match", () => {
  it("multi-token query matches a belief when every token appears in subject/predicate/object", () => {
    // Regression fix: previously `query: 'demo/hello status'` looked for the
    // literal 18-char substring and returned 0 matches. After v0.1.9 the
    // query is tokenized on whitespace and each token is checked
    // independently — so a belief with subject=demo/hello, predicate=status
    // matches because both tokens are found.
    const s = new EngineState();
    believe(s, {
      subject: "demo/hello",
      predicate: "status",
      object: "it works",
      signer_seed: "tok-test",
    });
    const sid = [...s.beliefs.values()][0].signer_id;
    s.setTrust(sid, "status", 0.9);

    const hit = recall(s, { query: "demo/hello status" });
    expect(hit.total_matched).toBe(1);
  });

  it("single-token query behaves identically to pre-v0.1.9 substring match", () => {
    const s = new EngineState();
    believe(s, {
      subject: "weather:cambridge",
      predicate: "traffic",
      object: "congested",
      signer_seed: "tok-single",
    });
    const sid = [...s.beliefs.values()][0].signer_id;
    s.setTrust(sid, "traffic", 0.9);

    expect(recall(s, { query: "cambridge" }).total_matched).toBe(1);
    expect(recall(s, { query: "congested" }).total_matched).toBe(1);
    expect(recall(s, { query: "traffic" }).total_matched).toBe(1);
    expect(recall(s, { query: "nonmatching" }).total_matched).toBe(0);
  });

  it("all tokens must match — missing any one token rejects the belief", () => {
    const s = new EngineState();
    believe(s, {
      subject: "demo/hello",
      predicate: "status",
      object: "it works",
      signer_seed: "tok-and",
    });
    const sid = [...s.beliefs.values()][0].signer_id;
    s.setTrust(sid, "status", 0.9);

    // Both tokens present → match
    expect(recall(s, { query: "demo/hello works" }).total_matched).toBe(1);
    // Second token absent → no match (token-AND, not token-OR)
    expect(recall(s, { query: "demo/hello absent" }).total_matched).toBe(0);
  });

  it("empty and whitespace-only queries match every belief (no-op)", () => {
    const s = new EngineState();
    believe(s, {
      subject: "a",
      predicate: "p",
      object: 1,
      signer_seed: "tok-empty",
    });
    const sid = [...s.beliefs.values()][0].signer_id;
    s.setTrust(sid, "p", 0.9);

    expect(recall(s, { query: "" }).total_matched).toBe(1);
    expect(recall(s, { query: "   " }).total_matched).toBe(1);
    expect(recall(s, { query: "\t\n  " }).total_matched).toBe(1);
  });

  it("tokens matching ACROSS fields still count — subject+predicate+object together", () => {
    // token "cambridge" in subject, token "congested" in object — both match
    const s = new EngineState();
    believe(s, {
      subject: "weather:cambridge",
      predicate: "traffic",
      object: "congested (+14 min)",
      signer_seed: "tok-across",
    });
    const sid = [...s.beliefs.values()][0].signer_id;
    s.setTrust(sid, "traffic", 0.9);

    expect(recall(s, { query: "cambridge congested" }).total_matched).toBe(1);
  });
});

describe("believe() validates causes[]", () => {
  it("throws when causes[] contains an unknown belief id", () => {
    const s = new EngineState();
    expect(() =>
      believe(s, {
        subject: "scene:x",
        predicate: "p",
        object: 1,
        signer_seed: "alice",
        causes: ["0".repeat(64)],
      })
    ).toThrow(/unknown cause id/);
  });

  it("accepts causes[] that point at existing beliefs (happy path)", () => {
    const s = new EngineState();
    const parent = believe(s, { subject: "p", predicate: "p", object: 1, signer_seed: "alice" });
    expect(() =>
      believe(s, {
        subject: "c",
        predicate: "p",
        object: 2,
        signer_seed: "alice",
        causes: [parent.id],
      })
    ).not.toThrow();
  });

  it("accepts missing causes[] (undefined and empty array)", () => {
    const s = new EngineState();
    expect(() =>
      believe(s, { subject: "x", predicate: "p", object: 1, signer_seed: "alice" })
    ).not.toThrow();
    expect(() =>
      believe(s, {
        subject: "y",
        predicate: "p",
        object: 2,
        signer_seed: "alice",
        causes: [],
      })
    ).not.toThrow();
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
