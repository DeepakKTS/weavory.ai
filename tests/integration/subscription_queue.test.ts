/**
 * Integration tests — subscription queue (Phase G.2 · W-0110)
 *
 * Covers:
 *   - subscribe() returns a subscription with a bounded queue
 *   - believing a matching belief enqueues to every matching subscription
 *   - non-matching beliefs are not enqueued
 *   - recall(subscription_id) drains the queue + returns delivered count
 *   - queue overflow drops the oldest entries + bumps dropped_count
 *   - filters (subject / predicate) constrain matches at enqueue time
 *   - a second drain after a believe sees only the new belief
 */
import { describe, it, expect } from "vitest";
import { EngineState } from "../../src/engine/state.js";
import { attest, believe, recall, subscribe } from "../../src/engine/ops.js";

function newState(): EngineState {
  return new EngineState();
}

describe("subscribe + queue basics (W-0110)", () => {
  it("returns a subscription_id, created_at, signer_id, queue_cap", () => {
    const s = newState();
    const sub = subscribe(s, { pattern: "traffic", signer_seed: "bob" });
    expect(sub.subscription_id).toMatch(/^sub_[0-9a-f]+$/);
    expect(sub.signer_id).toMatch(/^[0-9a-f]{64}$/);
    expect(sub.queue_cap).toBe(1000);
    expect(typeof sub.created_at).toBe("string");
  });

  it("respects a custom queue_cap >= 1", () => {
    const s = newState();
    const sub = subscribe(s, { pattern: "x", queue_cap: 2 });
    expect(sub.queue_cap).toBe(2);
  });
});

describe("match enqueue (W-0110)", () => {
  it("enqueues matching beliefs for existing subscriptions", () => {
    const s = newState();
    const sub = subscribe(s, { pattern: "traffic", signer_seed: "bob" });

    const b = believe(s, {
      subject: "scenario:traffic-cambridge",
      predicate: "observation",
      object: { congested: true },
      signer_seed: "alice",
    });

    const stored = s.subscriptions.get(sub.subscription_id);
    expect(stored).toBeDefined();
    expect(stored?.queue).toHaveLength(1);
    expect(stored?.queue[0].id).toBe(b.id);
    expect(stored?.matches_since_created).toBe(1);
  });

  it("does not enqueue non-matching beliefs", () => {
    const s = newState();
    const sub = subscribe(s, { pattern: "weather", signer_seed: "bob" });

    believe(s, {
      subject: "market:AAPL",
      predicate: "rumor",
      object: "pop",
      signer_seed: "alice",
    });

    const stored = s.subscriptions.get(sub.subscription_id);
    expect(stored?.queue).toHaveLength(0);
    expect(stored?.matches_since_created).toBe(0);
  });

  it("routes one belief to multiple matching subscriptions", () => {
    const s = newState();
    const a = subscribe(s, { pattern: "traffic" });
    const b = subscribe(s, { pattern: "cambridge" });
    const c = subscribe(s, { pattern: "nope" });

    believe(s, {
      subject: "scenario:traffic-cambridge",
      predicate: "observation",
      object: "x",
      signer_seed: "alice",
    });

    expect(s.subscriptions.get(a.subscription_id)?.queue).toHaveLength(1);
    expect(s.subscriptions.get(b.subscription_id)?.queue).toHaveLength(1);
    expect(s.subscriptions.get(c.subscription_id)?.queue).toHaveLength(0);
  });

  it("honors subscription filters (subject + predicate)", () => {
    const s = newState();
    const sub = subscribe(s, {
      pattern: "",
      filters: { subject: "allowed", predicate: "observation" },
    });

    believe(s, { subject: "allowed", predicate: "observation", object: 1, signer_seed: "a" });
    believe(s, { subject: "other", predicate: "observation", object: 2, signer_seed: "a" });
    believe(s, { subject: "allowed", predicate: "rumor", object: 3, signer_seed: "a" });

    const stored = s.subscriptions.get(sub.subscription_id);
    expect(stored?.queue).toHaveLength(1);
    expect(stored?.queue[0].subject).toBe("allowed");
    expect(stored?.queue[0].predicate).toBe("observation");
  });
});

describe("recall drain (W-0110)", () => {
  it("drains the queue and returns delivered_count + dropped_count", () => {
    const s = newState();
    const sub = subscribe(s, { pattern: "x" });

    const w = believe(s, { subject: "x-one", predicate: "p", object: 1, signer_seed: "a" });
    // Raise trust so default min_trust doesn't filter out Alice.
    attest(s, { signer_id: w.signer_id, topic: "p", score: 0.9 });

    const r = recall(s, { query: "", subscription_id: sub.subscription_id });
    expect(r.subscription_id).toBe(sub.subscription_id);
    expect(r.delivered_count).toBe(1);
    expect(r.dropped_count).toBe(0);
    expect(r.beliefs).toHaveLength(1);
    expect(r.beliefs[0].id).toBe(w.id);

    // Second drain immediately → empty.
    const r2 = recall(s, { query: "", subscription_id: sub.subscription_id });
    expect(r2.delivered_count).toBe(0);
    expect(r2.beliefs).toHaveLength(0);
  });

  it("returns delivered_count=0 for an unknown subscription_id", () => {
    const s = newState();
    const r = recall(s, { query: "", subscription_id: "sub_deadbeef" });
    expect(r.delivered_count).toBe(0);
    expect(r.beliefs).toHaveLength(0);
  });

  it("drain after more believes shows only the new ones", () => {
    const s = newState();
    const sub = subscribe(s, { pattern: "x" });

    const a = believe(s, { subject: "x-one", predicate: "p", object: 1, signer_seed: "alice" });
    attest(s, { signer_id: a.signer_id, topic: "p", score: 0.9 });
    recall(s, { query: "", subscription_id: sub.subscription_id }); // drain

    const b = believe(s, { subject: "x-two", predicate: "p", object: 2, signer_seed: "alice" });
    const r = recall(s, { query: "", subscription_id: sub.subscription_id });
    expect(r.delivered_count).toBe(1);
    expect(r.beliefs[0].id).toBe(b.id);
  });
});

describe("queue overflow (W-0110)", () => {
  it("drops oldest beyond queue_cap and increments dropped_count", () => {
    const s = newState();
    const sub = subscribe(s, { pattern: "", queue_cap: 2 });

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = believe(s, {
        subject: `s-${i}`,
        predicate: "p",
        object: i,
        signer_seed: "alice",
      });
      ids.push(out.id);
    }
    attest(s, { signer_id: s.subscriptions.get(sub.subscription_id)!.queue[0].signer_id, topic: "p", score: 0.9 });

    const stored = s.subscriptions.get(sub.subscription_id);
    expect(stored?.queue).toHaveLength(2);
    // Oldest three were dropped, so queue holds ids[3] and ids[4].
    expect(stored?.queue.map((b) => b.id)).toEqual([ids[3], ids[4]]);
    expect(stored?.dropped_count).toBe(3);

    const r = recall(s, { query: "", subscription_id: sub.subscription_id });
    expect(r.delivered_count).toBe(2);
    expect(r.dropped_count).toBe(3);
  });
});

describe("Gate-3 regression (W-0110)", () => {
  it("default recall without subscription_id still returns all live beliefs", () => {
    const s = newState();
    const w = believe(s, { subject: "plain", predicate: "p", object: "hi", signer_seed: "alice" });
    attest(s, { signer_id: w.signer_id, topic: "p", score: 0.9 });

    const r = recall(s, { query: "plain" });
    expect(r.beliefs).toHaveLength(1);
    expect(r.subscription_id).toBeUndefined();
    expect(r.delivered_count).toBeUndefined();
  });
});

describe("consensus merge + conflict visibility (W-0111)", () => {
  it("default recall (no merge_strategy) returns all conflicting variants", () => {
    const s = newState();
    const honest = believe(s, {
      subject: "scene:default",
      predicate: "obs",
      object: { congested: true },
      signer_seed: "alice",
    });
    const liar = believe(s, {
      subject: "scene:default",
      predicate: "obs",
      object: { congested: false },
      signer_seed: "mallet",
    });
    attest(s, { signer_id: honest.signer_id, topic: "obs", score: 0.9 });
    attest(s, { signer_id: liar.signer_id, topic: "obs", score: 0.4 });

    const r = recall(s, { query: "scene" });
    // Default behavior preserved — both variants flow through, no merge strategy set.
    expect(r.beliefs).toHaveLength(2);
    expect(r.merge_strategy).toBeUndefined();
    expect(r.conflicts).toBeUndefined();
  });

  it("include_conflicts=true surfaces groups without collapsing the list", () => {
    const s = newState();
    const honest = believe(s, {
      subject: "scene:vis",
      predicate: "obs",
      object: { congested: true },
      signer_seed: "alice",
    });
    const liar = believe(s, {
      subject: "scene:vis",
      predicate: "obs",
      object: { congested: false },
      signer_seed: "mallet",
    });
    attest(s, { signer_id: honest.signer_id, topic: "obs", score: 0.9 });
    attest(s, { signer_id: liar.signer_id, topic: "obs", score: 0.4 });

    const r = recall(s, { query: "scene", include_conflicts: true });
    // Both variants still returned…
    expect(r.beliefs).toHaveLength(2);
    // …plus the conflict group is exposed for introspection.
    expect(r.conflicts).toBeDefined();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts?.[0].variants).toHaveLength(2);
  });

  it("consensus strategy (opt-in) collapses conflicting beliefs to a trust-weighted winner", () => {
    const s = newState();
    const honest = believe(s, {
      subject: "scene:x",
      predicate: "obs",
      object: { congested: true },
      signer_seed: "alice",
    });
    const liar = believe(s, {
      subject: "scene:x",
      predicate: "obs",
      object: { congested: false },
      signer_seed: "mallet",
    });
    attest(s, { signer_id: honest.signer_id, topic: "obs", score: 0.9 });
    attest(s, { signer_id: liar.signer_id, topic: "obs", score: 0.4 });

    const r = recall(s, { query: "scene", merge_strategy: "consensus" });
    expect(r.beliefs).toHaveLength(1);
    expect(r.beliefs[0].id).toBe(honest.id);
    // Default: no conflicts surfaced.
    expect(r.conflicts).toBeUndefined();
    expect(r.merge_strategy).toBe("consensus");
  });

  it("include_conflicts exposes variants when set to true", () => {
    const s = newState();
    const honest = believe(s, {
      subject: "scene:y",
      predicate: "obs",
      object: { congested: true },
      signer_seed: "alice",
    });
    const liar = believe(s, {
      subject: "scene:y",
      predicate: "obs",
      object: { congested: false },
      signer_seed: "mallet",
    });
    attest(s, { signer_id: honest.signer_id, topic: "obs", score: 0.9 });
    attest(s, { signer_id: liar.signer_id, topic: "obs", score: 0.4 });

    const r = recall(s, { query: "scene", include_conflicts: true });
    expect(r.conflicts).toBeDefined();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts?.[0].variants).toHaveLength(2);
    expect(r.conflicts?.[0].winner.id).toBe(honest.id);
  });

  it("lww merge strategy ignores trust and picks the latest", async () => {
    const s = newState();
    const first = believe(s, {
      subject: "scene:z",
      predicate: "obs",
      object: { value: 1 },
      signer_seed: "alice",
    });
    // Nudge the clock so the second belief has a strictly-later recorded_at.
    await new Promise((r) => setTimeout(r, 10));
    const second = believe(s, {
      subject: "scene:z",
      predicate: "obs",
      object: { value: 2 },
      signer_seed: "mallet",
    });
    // Both must pass the default min_trust=0.3 gate so BOTH reach the merge
    // step. lww's job is to ignore the *relative* trust and pick the later one.
    attest(s, { signer_id: first.signer_id, topic: "obs", score: 0.9 });
    attest(s, { signer_id: second.signer_id, topic: "obs", score: 0.4 });

    const r = recall(s, { query: "scene", merge_strategy: "lww" });
    expect(r.beliefs).toHaveLength(1);
    // LWW picks the later recorded_at (second) even though first has higher trust.
    expect(r.beliefs[0].id).toBe(second.id);
  });

  it("as_of queries skip merge (historical fidelity preserved)", async () => {
    const s = newState();
    const a = believe(s, {
      subject: "scene:hist",
      predicate: "obs",
      object: { v: "a" },
      signer_seed: "alice",
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = believe(s, {
      subject: "scene:hist",
      predicate: "obs",
      object: { v: "b" },
      signer_seed: "bob",
    });
    attest(s, { signer_id: a.signer_id, topic: "obs", score: 0.9 });
    attest(s, { signer_id: b.signer_id, topic: "obs", score: 0.9 });

    const future = new Date().toISOString();
    const rHist = recall(s, { query: "scene", as_of: future });
    // as_of branch keeps all variants so historians can see disagreement.
    expect(rHist.total_matched).toBe(2);
  });
});
