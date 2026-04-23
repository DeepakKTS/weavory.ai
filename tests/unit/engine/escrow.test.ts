/**
 * Unit tests — src/engine/escrow.ts (Phase G.5 · W-0140 + W-0141)
 */
import { describe, it, expect } from "vitest";
import { EngineState } from "../../../src/engine/state.js";
import { attest, believe, forget, recall } from "../../../src/engine/ops.js";
import {
  CAPABILITY_OFFERS_PREDICATE,
  ESCROW_DELIVERED_PREDICATE,
  ESCROW_PAYMENT_PREDICATE,
  ESCROW_SETTLED_PREDICATE,
  escrowStatus,
  findCapabilities,
  getReputation,
  isEscrowSettled,
  walkEscrowThread,
} from "../../../src/engine/escrow.js";

describe("getReputation (W-0140)", () => {
  it("returns zeros for an unknown signer", () => {
    const s = new EngineState();
    const r = getReputation(s, "a".repeat(64));
    expect(r.signer_id).toBe("a".repeat(64));
    expect(r.topics).toEqual([]);
    expect(r.avg_trust).toBe(0);
    expect(r.attestation_count).toBe(0);
    expect(r.beliefs_authored).toBe(0);
    expect(r.beliefs_live).toBe(0);
  });

  it("aggregates attested topics, averages trust, and counts authored beliefs", () => {
    const s = new EngineState();
    const b1 = believe(s, { subject: "s1", predicate: "p", object: 1, signer_seed: "alice" });
    believe(s, { subject: "s2", predicate: "q", object: 2, signer_seed: "alice" });
    attest(s, { signer_id: b1.signer_id, topic: "p", score: 0.9 });
    attest(s, { signer_id: b1.signer_id, topic: "q", score: 0.3 });

    const r = getReputation(s, b1.signer_id);
    expect(r.attestation_count).toBe(2);
    expect(r.avg_trust).toBeCloseTo(0.6);
    expect(r.topics.map((t) => t.topic)).toEqual(["p", "q"]);
    expect(r.beliefs_authored).toBe(2);
    expect(r.beliefs_live).toBe(2);
    expect(r.beliefs_tombstoned).toBe(0);
  });

  it("counts tombstoned beliefs separately from live", () => {
    const s = new EngineState();
    const b = believe(s, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    forget(s, { belief_id: b.id, forgetter_seed: "alice" });
    const r = getReputation(s, b.signer_id);
    expect(r.beliefs_authored).toBe(1);
    expect(r.beliefs_live).toBe(0);
    expect(r.beliefs_tombstoned).toBe(1);
  });

  it("topics are sorted alphabetically for deterministic output", () => {
    const s = new EngineState();
    const b = believe(s, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    attest(s, { signer_id: b.signer_id, topic: "z", score: 0.1 });
    attest(s, { signer_id: b.signer_id, topic: "a", score: 0.8 });
    attest(s, { signer_id: b.signer_id, topic: "m", score: 0.5 });
    const r = getReputation(s, b.signer_id);
    expect(r.topics.map((t) => t.topic)).toEqual(["a", "m", "z"]);
  });
});

describe("findCapabilities (W-0141)", () => {
  it("returns only beliefs with predicate 'capability.offers'", () => {
    const s = new EngineState();
    believe(s, {
      subject: "agent:alice",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "summarize", price: 5 },
      signer_seed: "alice",
    });
    believe(s, {
      subject: "agent:bob",
      predicate: "observation",
      object: { temp: 20 },
      signer_seed: "bob",
    });
    const offers = findCapabilities(s);
    expect(offers).toHaveLength(1);
    expect(offers[0].subject).toBe("agent:alice");
    expect(offers[0].withdrawn).toBe(false);
    expect(
      (offers[0].capability as { name: string }).name
    ).toBe("summarize");
  });

  it("filters by object.name when provided", () => {
    const s = new EngineState();
    believe(s, {
      subject: "agent:alice",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "summarize", price: 5 },
      signer_seed: "alice",
    });
    believe(s, {
      subject: "agent:bob",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "translate", price: 8 },
      signer_seed: "bob",
    });
    const summarize = findCapabilities(s, "summarize");
    expect(summarize).toHaveLength(1);
    expect(summarize[0].subject).toBe("agent:alice");
    const nothing = findCapabilities(s, "unknown");
    expect(nothing).toEqual([]);
  });

  it("flags withdrawn offers (tombstoned) but still returns them", () => {
    const s = new EngineState();
    const b = believe(s, {
      subject: "agent:alice",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "summarize", price: 5 },
      signer_seed: "alice",
    });
    forget(s, { belief_id: b.id, forgetter_seed: "alice" });
    const offers = findCapabilities(s, "summarize");
    expect(offers).toHaveLength(1);
    expect(offers[0].withdrawn).toBe(true);
  });

  it("sorts newest-first by recorded_at", async () => {
    const s = new EngineState();
    const first = believe(s, {
      subject: "agent:alice",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "summarize", price: 5 },
      signer_seed: "alice",
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = believe(s, {
      subject: "agent:bob",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "summarize", price: 4 },
      signer_seed: "bob",
    });
    const offers = findCapabilities(s, "summarize");
    expect(offers.map((o) => o.offer_id)).toEqual([second.id, first.id]);
  });
});

describe("walkEscrowThread + escrowStatus (W-0142)", () => {
  function fourStageEscrow() {
    const s = new EngineState();
    // 1. Alice offers.
    const offer = believe(s, {
      subject: "agent:alice",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "summarize", price: 5, escrow_required: true },
      signer_seed: "alice",
    });
    // 2. Bob pays.
    const payment = believe(s, {
      subject: "agent:bob",
      predicate: ESCROW_PAYMENT_PREDICATE,
      object: { offer_id: offer.id, amount: 5 },
      signer_seed: "bob",
      causes: [offer.id],
    });
    // 3. Alice delivers.
    const delivered = believe(s, {
      subject: "agent:alice",
      predicate: ESCROW_DELIVERED_PREDICATE,
      object: { payment_id: payment.id, result: "<summary>" },
      signer_seed: "alice",
      causes: [payment.id],
    });
    // 4. Bob settles.
    const settled = believe(s, {
      subject: "agent:bob",
      predicate: ESCROW_SETTLED_PREDICATE,
      object: { delivery_id: delivered.id, outcome: "accepted" },
      signer_seed: "bob",
      causes: [delivered.id],
    });
    return { s, offer, payment, delivered, settled };
  }

  it("returns an empty array when the root belief does not exist", () => {
    const s = new EngineState();
    expect(walkEscrowThread(s, "0".repeat(64))).toEqual([]);
  });

  it("returns just the root when no other beliefs cite it", () => {
    const s = new EngineState();
    const offer = believe(s, {
      subject: "agent:alice",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "x" },
      signer_seed: "alice",
    });
    const thread = walkEscrowThread(s, offer.id);
    expect(thread).toHaveLength(1);
    expect(thread[0].stage).toBe("offer");
    expect(thread[0].belief_id).toBe(offer.id);
  });

  it("walks the full four-stage escrow in order", () => {
    const { s, offer, payment, delivered, settled } = fourStageEscrow();
    const thread = walkEscrowThread(s, offer.id);
    expect(thread.map((t) => t.stage)).toEqual(["offer", "payment", "delivered", "settled"]);
    expect(thread.map((t) => t.belief_id)).toEqual([offer.id, payment.id, delivered.id, settled.id]);
  });

  it("escrowStatus flags the thread as settled when outcome=accepted", () => {
    const { s, offer } = fourStageEscrow();
    const status = escrowStatus(s, offer.id);
    expect(status.has_offer).toBe(true);
    expect(status.has_payment).toBe(true);
    expect(status.has_delivered).toBe(true);
    expect(status.has_settled).toBe(true);
    expect(status.settled).toBe(true);
    expect(status.outcome).toBe("accepted");
    expect(isEscrowSettled(s, offer.id)).toBe(true);
  });

  it("escrowStatus records 'disputed' without flagging settled=true", async () => {
    const { s, offer, delivered } = fourStageEscrow();
    // Override the settlement to a dispute by publishing a newer settled
    // step with outcome=disputed. LWW merge picks the latest recorded_at,
    // so we need to ensure the disputed belief has a strictly later
    // timestamp than the original 'accepted' one from fourStageEscrow().
    // Node's Date.now() resolution is 1ms, so a 2ms sleep guarantees
    // monotonic ordering without depending on real-time scheduler jitter.
    await new Promise((r) => setTimeout(r, 2));
    believe(s, {
      subject: "agent:bob",
      predicate: ESCROW_SETTLED_PREDICATE,
      object: { delivery_id: delivered.id, outcome: "disputed" },
      signer_seed: "bob",
      causes: [delivered.id],
    });
    const status = escrowStatus(s, offer.id);
    expect(status.has_settled).toBe(true);
    expect(status.outcome).toBe("disputed");
    expect(status.settled).toBe(false);
    expect(isEscrowSettled(s, offer.id)).toBe(false);
  });

  it("traverses a fan-out (multiple children of the offer)", () => {
    const s = new EngineState();
    const offer = believe(s, {
      subject: "agent:alice",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "summarize" },
      signer_seed: "alice",
    });
    // Two bidders both pay on the same offer.
    const pay1 = believe(s, {
      subject: "agent:bob",
      predicate: ESCROW_PAYMENT_PREDICATE,
      object: { offer_id: offer.id, amount: 5 },
      signer_seed: "bob",
      causes: [offer.id],
    });
    const pay2 = believe(s, {
      subject: "agent:carol",
      predicate: ESCROW_PAYMENT_PREDICATE,
      object: { offer_id: offer.id, amount: 7 },
      signer_seed: "carol",
      causes: [offer.id],
    });
    const thread = walkEscrowThread(s, offer.id);
    expect(thread.map((t) => t.belief_id)).toContain(offer.id);
    expect(thread.map((t) => t.belief_id)).toContain(pay1.id);
    expect(thread.map((t) => t.belief_id)).toContain(pay2.id);
    expect(thread).toHaveLength(3);
  });

  it("does not double-count diamond-shaped DAGs", () => {
    // root → a → c, root → b → c (c has two parents).
    const s = new EngineState();
    const root = believe(s, {
      subject: "s",
      predicate: CAPABILITY_OFFERS_PREDICATE,
      object: { name: "x" },
      signer_seed: "alice",
    });
    const a = believe(s, {
      subject: "s",
      predicate: ESCROW_PAYMENT_PREDICATE,
      object: { v: "a" },
      signer_seed: "bob",
      causes: [root.id],
    });
    const b = believe(s, {
      subject: "s",
      predicate: ESCROW_PAYMENT_PREDICATE,
      object: { v: "b" },
      signer_seed: "bob",
      causes: [root.id],
    });
    believe(s, {
      subject: "s",
      predicate: ESCROW_DELIVERED_PREDICATE,
      object: { via: "both" },
      signer_seed: "alice",
      causes: [a.id, b.id],
    });
    const thread = walkEscrowThread(s, root.id);
    expect(thread).toHaveLength(4); // root + a + b + c (not 5)
  });
});

describe("recall filters.reputation_of attaches a summary (W-0140 integration)", () => {
  it("restricts to authored beliefs AND attaches ReputationSummary", () => {
    const s = new EngineState();
    const a = believe(s, {
      subject: "s1",
      predicate: "p",
      object: 1,
      signer_seed: "alice",
    });
    believe(s, {
      subject: "s2",
      predicate: "p",
      object: 2,
      signer_seed: "bob",
    });
    attest(s, { signer_id: a.signer_id, topic: "p", score: 0.7 });

    const r = recall(s, {
      query: "",
      min_trust: -1, // include both regardless of trust gate
      filters: { reputation_of: a.signer_id },
    });
    expect(r.beliefs).toHaveLength(1);
    expect(r.beliefs[0].signer_id).toBe(a.signer_id);
    expect(r.reputation).toBeDefined();
    expect(r.reputation?.signer_id).toBe(a.signer_id);
    expect(r.reputation?.beliefs_authored).toBe(1);
    expect(r.reputation?.topics).toEqual([{ topic: "p", score: 0.7 }]);
  });

  it("omits reputation from output when filter is unset", () => {
    const s = new EngineState();
    believe(s, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    const r = recall(s, { query: "" });
    expect(r.reputation).toBeUndefined();
  });
});
