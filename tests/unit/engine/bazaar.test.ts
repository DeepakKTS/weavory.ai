/**
 * Unit tests — src/engine/bazaar.ts (Phase G.5 · W-0140 + W-0141)
 */
import { describe, it, expect } from "vitest";
import { EngineState } from "../../../src/engine/state.js";
import { attest, believe, forget, recall } from "../../../src/engine/ops.js";
import {
  CAPABILITY_OFFERS_PREDICATE,
  findCapabilities,
  getReputation,
} from "../../../src/engine/bazaar.js";

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
