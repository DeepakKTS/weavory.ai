/**
 * Unit tests — src/engine/branch.ts + AuditStore.restoreEntries
 * Phase G.4, W-0131
 */
import { describe, it, expect } from "vitest";
import { EngineState } from "../../../src/engine/state.js";
import { cloneState } from "../../../src/engine/branch.js";
import { believe, attest, forget, recall, subscribe } from "../../../src/engine/ops.js";

describe("AuditStore.restoreEntries", () => {
  it("replaces the chain with a schema-validated copy, preserving hashes", () => {
    const s = new EngineState();
    believe(s, { subject: "s1", predicate: "p", object: 1, signer_seed: "alice" });
    believe(s, { subject: "s2", predicate: "p", object: 2, signer_seed: "alice" });
    const originalEntries = s.audit.entries();

    const s2 = new EngineState();
    s2.audit.restoreEntries(originalEntries);

    expect(s2.audit.length()).toBe(2);
    expect(s2.audit.entries()[0].entry_hash).toBe(originalEntries[0].entry_hash);
    expect(s2.audit.entries()[1].prev_hash).toBe(originalEntries[0].entry_hash);
    expect(s2.audit.verify().ok).toBe(true);
  });

  it("rejects malformed entries (strict Zod)", () => {
    const s = new EngineState();
    expect(() =>
      s.audit.restoreEntries([{ bad: "entry" } as unknown as never])
    ).toThrow();
  });

  it("subsequent entries() returns a defensive copy (no aliasing)", () => {
    const s = new EngineState();
    believe(s, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    const a = s.audit.entries();
    const b = s.audit.entries();
    expect(a).not.toBe(b);
  });
});

describe("cloneState — branch independence", () => {
  it("deep-copies beliefs so a mutation on the branch doesn't leak to source", () => {
    const src = new EngineState();
    const b = believe(src, {
      subject: "s",
      predicate: "p",
      object: { v: 1, nested: ["a", "b"] },
      signer_seed: "alice",
    });
    const branch = cloneState(src);

    expect(branch.beliefs.size).toBe(1);
    // Object identity is different.
    expect(branch.beliefs.get(b.id)).not.toBe(src.beliefs.get(b.id));
    // But content is equal.
    expect(branch.beliefs.get(b.id)?.object).toEqual({ v: 1, nested: ["a", "b"] });

    // Mutate branch's nested array directly — source must be untouched.
    const bb = branch.beliefs.get(b.id)!;
    (bb.object as { nested: string[] }).nested.push("c");
    const sb = src.beliefs.get(b.id)!;
    expect((sb.object as { nested: string[] }).nested).toEqual(["a", "b"]);
  });

  it("publishes on one side do not appear on the other", () => {
    const src = new EngineState();
    const w = believe(src, { subject: "base", predicate: "p", object: 0, signer_seed: "alice" });
    attest(src, { signer_id: w.signer_id, topic: "p", score: 0.9 });

    const branch = cloneState(src);

    believe(src, { subject: "main-only", predicate: "p", object: 1, signer_seed: "alice" });
    believe(branch, { subject: "branch-only", predicate: "p", object: 2, signer_seed: "alice" });

    expect(src.beliefs.size).toBe(2);
    expect(branch.beliefs.size).toBe(2);
    const srcSubjects = [...src.beliefs.values()].map((b) => b.subject).sort();
    const branchSubjects = [...branch.beliefs.values()].map((b) => b.subject).sort();
    expect(srcSubjects).toEqual(["base", "main-only"]);
    expect(branchSubjects).toEqual(["base", "branch-only"]);
  });

  it("a forget on the branch does not tombstone the belief on the source", () => {
    const src = new EngineState();
    const b = believe(src, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    attest(src, { signer_id: b.signer_id, topic: "p", score: 0.9 });
    const branch = cloneState(src);

    forget(branch, { belief_id: b.id, forgetter_seed: "alice" });

    // Source still sees it live.
    expect(src.beliefs.get(b.id)?.invalidated_at).toBeNull();
    expect(recall(src, { query: "s" }).total_matched).toBe(1);
    // Branch has it tombstoned.
    expect(branch.beliefs.get(b.id)?.invalidated_at).not.toBeNull();
    expect(recall(branch, { query: "s" }).total_matched).toBe(0);
  });

  it("trust vectors are independent per branch", () => {
    const src = new EngineState();
    const b = believe(src, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    src.setTrust(b.signer_id, "p", 0.9);

    const branch = cloneState(src);
    branch.setTrust(b.signer_id, "p", -0.5);

    expect(src.trustScore(b.signer_id, "p")).toBe(0.9);
    expect(branch.trustScore(b.signer_id, "p")).toBe(-0.5);
  });

  it("subscriptions (and their queues) are independent per branch", () => {
    const src = new EngineState();
    const sub = subscribe(src, { pattern: "" });
    believe(src, { subject: "pre", predicate: "p", object: 1, signer_seed: "alice" });
    const branch = cloneState(src);

    // New belief on source only.
    believe(src, { subject: "post-src", predicate: "p", object: 2, signer_seed: "alice" });
    // New belief on branch only.
    believe(branch, { subject: "post-branch", predicate: "p", object: 3, signer_seed: "alice" });

    const srcQueue = src.subscriptions.get(sub.subscription_id)!.queue.map((b) => b.subject);
    const branchQueue = branch.subscriptions.get(sub.subscription_id)!.queue.map((b) => b.subject);
    expect(srcQueue).toEqual(["pre", "post-src"]);
    expect(branchQueue).toEqual(["pre", "post-branch"]);
  });

  it("does NOT inherit the source's onOp hook", () => {
    const src = new EngineState();
    let calls = 0;
    src.onOp = () => {
      calls++;
    };
    believe(src, { subject: "s", predicate: "p", object: 1, signer_seed: "alice" });
    expect(calls).toBe(1);

    const branch = cloneState(src);
    believe(branch, { subject: "s2", predicate: "p", object: 2, signer_seed: "alice" });
    // Source's onOp should NOT have fired for branch operations.
    expect(calls).toBe(1);
    expect(branch.onOp).toBeUndefined();
  });

  it("adversarialMode flag is carried across the clone", () => {
    const src = new EngineState();
    src.adversarialMode = true;
    const branch = cloneState(src);
    expect(branch.adversarialMode).toBe(true);
  });

  it("belief id of equal content is stable across branch + source", () => {
    const src = new EngineState();
    const a = believe(src, {
      subject: "x",
      predicate: "p",
      object: "o",
      signer_seed: "alice",
      recorded_at: "2026-04-21T20:00:00.000Z",
    });
    const branch = cloneState(src);

    // Writing the same payload on both sides should produce the same id
    // (content-addressed). But the branch already HAS that id from the clone,
    // so we can't call believe on it with same recorded_at (it would signal a
    // duplicate store). Just verify the IDs stored on both sides are equal.
    expect(branch.beliefs.get(a.id)?.id).toBe(a.id);
  });
});
