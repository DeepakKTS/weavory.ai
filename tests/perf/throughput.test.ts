/**
 * tests/perf/throughput.test.ts
 *
 * Steady-state throughput smoke-tests. These are intentionally loose
 * (CI runners vary wildly) but catch order-of-magnitude regressions:
 * if signing/recall suddenly takes 50ms per op, a perf regression is
 * front-and-center in CI.
 *
 * Numbers are conservative to stay green on GitHub Actions' smallest
 * Linux runner. Local laptops typically come in well under the caps.
 */
import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { EngineState } from "../../src/engine/state.js";
import { believe, recall, subscribe } from "../../src/engine/ops.js";

const WARMUP = 10;

function seed(state: EngineState, n: number, seedName = "bench-writer"): void {
  for (let i = 0; i < n; i++) {
    believe(state, {
      subject: `scene:${i}`,
      predicate: i % 2 === 0 ? "even" : "odd",
      object: { i, payload: "x".repeat(32) },
      signer_seed: seedName,
    });
  }
}

describe("perf — believe() throughput", () => {
  it("writes 1000 beliefs with a shared signer under the budget", () => {
    const s = new EngineState();
    seed(s, WARMUP); // warm up the keyring + audit chain

    const t0 = performance.now();
    seed(s, 1000);
    const dt = performance.now() - t0;

    // Conservative cap: 1000 Ed25519 signs + 1000 BLAKE3 hashes should
    // finish in <4s even on a slow CI runner. Locally this is ~600ms.
    expect(dt).toBeLessThan(4000);
    expect(s.beliefs.size).toBe(1010);
    expect(s.audit.length()).toBe(1010);
  });
});

describe("perf — recall() query with lazy blob", () => {
  it("empty-query recall is O(beliefs) without blob construction", () => {
    const s = new EngineState();
    seed(s, 1000);

    // Raise trust so the default gate doesn't filter the bench signer.
    const signerId = [...s.beliefs.values()][0].signer_id;
    s.setTrust(signerId, "even", 0.9);
    s.setTrust(signerId, "odd", 0.9);

    const t0 = performance.now();
    const r = recall(s, { query: "", top_k: 50 });
    const dt = performance.now() - t0;

    // Empty query must skip JSON.stringify of the belief.object for every
    // belief — target: well under 200ms on 1000 beliefs.
    expect(dt).toBeLessThan(500);
    expect(r.total_matched).toBe(1000);
    expect(r.beliefs.length).toBe(50);
  });

  it("non-empty query prefilters subject/predicate before touching object blob", () => {
    const s = new EngineState();
    seed(s, 1000);
    const signerId = [...s.beliefs.values()][0].signer_id;
    s.setTrust(signerId, "even", 0.9);
    s.setTrust(signerId, "odd", 0.9);

    const t0 = performance.now();
    const r = recall(s, { query: "even", top_k: 50 });
    const dt = performance.now() - t0;

    // Most beliefs' predicate "odd" short-circuits out cheaply — we only
    // pay the blob cost for beliefs whose subject/predicate didn't match.
    // Cap loose: 1s on CI.
    expect(dt).toBeLessThan(1000);
    expect(r.total_matched).toBe(500);
  });
});

describe("perf — subscription fan-out (indexed by predicate)", () => {
  it("10 predicate-specific subs + 1000 beliefs: fan-out hits only the matching bucket", () => {
    const s = new EngineState();

    // 10 subscriptions all on predicate "even". A naive implementation would
    // check every subscription against every belief (10 × 1000 = 10K match
    // calls). With the bucket index, each belief touches only subs whose
    // filters.predicate matches, so "odd"-predicate beliefs skip these 10
    // entirely.
    for (let i = 0; i < 10; i++) {
      subscribe(s, { pattern: "", filters: { predicate: "even" } });
    }
    // And one "any predicate" subscription that matches everything.
    subscribe(s, { pattern: "" });

    const t0 = performance.now();
    seed(s, 1000);
    const dt = performance.now() - t0;

    // Shouldn't meaningfully regress from the plain 1000-write test.
    expect(dt).toBeLessThan(4500);

    // Every "even" subscription should have queued exactly 500 beliefs.
    const subs = [...s.subscriptions.values()];
    const evenSubs = subs.filter((x) => x.filters.predicate === "even");
    for (const sub of evenSubs) expect(sub.queue.length).toBe(500);

    // The unfiltered subscription should have queued all 1000.
    const unfiltered = subs.find((x) => x.filters.predicate === undefined);
    expect(unfiltered?.queue.length).toBe(1000);
  });
});
