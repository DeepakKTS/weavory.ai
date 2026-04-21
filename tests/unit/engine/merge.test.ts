/**
 * Unit tests — src/engine/merge.ts (Phase G.2, W-0111)
 *
 * Pure-function tests. Callers supply their own `trustOf`, so we don't need
 * an EngineState here.
 */
import { describe, it, expect } from "vitest";
import { mergeConflicts, type TrustLookup } from "../../../src/engine/merge.js";
import type { StoredBelief } from "../../../src/core/schema.js";

function mkBelief(partial: Partial<StoredBelief>): StoredBelief {
  return {
    schema_version: "1.0.0",
    subject: "s",
    predicate: "p",
    object: "default",
    confidence: 1,
    valid_from: null,
    valid_to: null,
    recorded_at: "2026-04-21T20:00:00.000Z",
    signer_id: "a".repeat(64),
    causes: [],
    id: "1".repeat(64),
    signature: "0".repeat(128),
    ingested_at: "2026-04-21T20:00:00.000Z",
    invalidated_at: null,
    invalidated_by: null,
    quarantined: false,
    quarantine_reason: null,
    ...partial,
  } as StoredBelief;
}

const neutralTrust: TrustLookup = () => 0.5;
const trustMap = (m: Record<string, number>): TrustLookup => (signer) => m[signer] ?? 0.5;

describe("merge: no conflict", () => {
  it("returns all beliefs unchanged when every (subject, predicate) is unique", () => {
    const a = mkBelief({ subject: "A", predicate: "p1", id: "a".repeat(64) });
    const b = mkBelief({ subject: "B", predicate: "p1", id: "b".repeat(64) });
    const r = mergeConflicts([a, b], neutralTrust);
    expect(r.merged).toHaveLength(2);
    expect(r.conflicts).toHaveLength(0);
  });

  it("multiple beliefs with same object value are consensus (not conflict)", () => {
    const a = mkBelief({
      subject: "A",
      predicate: "p",
      object: "same",
      recorded_at: "2026-04-21T20:00:00.000Z",
      id: "a".repeat(64),
      signer_id: "a".repeat(64),
    });
    const b = mkBelief({
      subject: "A",
      predicate: "p",
      object: "same",
      recorded_at: "2026-04-21T20:05:00.000Z",
      id: "b".repeat(64),
      signer_id: "b".repeat(64),
    });
    const r = mergeConflicts([a, b], neutralTrust);
    expect(r.conflicts).toHaveLength(0);
    expect(r.merged).toHaveLength(1);
    // LWW of the cohort wins.
    expect(r.merged[0].id).toBe(b.id);
  });
});

describe("merge: conflict detection", () => {
  const honest = mkBelief({
    subject: "S",
    predicate: "obs",
    object: { congested: true },
    recorded_at: "2026-04-21T20:01:00.000Z",
    id: "1".repeat(64),
    signer_id: "a".repeat(64),
  });
  const liar = mkBelief({
    subject: "S",
    predicate: "obs",
    object: { congested: false },
    recorded_at: "2026-04-21T20:02:00.000Z",
    id: "2".repeat(64),
    signer_id: "b".repeat(64),
  });

  it("consensus: trust-weighted vote picks the honest winner", () => {
    const trust = trustMap({
      [honest.signer_id]: 0.9,
      [liar.signer_id]: 0.1,
    });
    const r = mergeConflicts([honest, liar], trust, "consensus");
    expect(r.conflicts).toHaveLength(1);
    expect(r.merged).toHaveLength(1);
    expect(r.merged[0].id).toBe(honest.id);
    expect(r.conflicts[0].variants).toHaveLength(2);
    expect(r.conflicts[0].strategy).toBe("consensus");
    expect(r.conflicts[0].winner.id).toBe(honest.id);
    expect(r.conflicts[0].winning_support).toBeCloseTo(0.9);
    expect(r.conflicts[0].total_support).toBeCloseTo(1.0);
  });

  it("lww: latest recorded_at wins regardless of trust", () => {
    const trust = trustMap({
      [honest.signer_id]: 0.9, // more trust…
      [liar.signer_id]: 0.1, // …but liar's belief is newer
    });
    const r = mergeConflicts([honest, liar], trust, "lww");
    expect(r.merged[0].id).toBe(liar.id);
    expect(r.conflicts[0].strategy).toBe("lww");
  });

  it("consensus with equal weight: LWW tie-break", () => {
    const trust = trustMap({
      [honest.signer_id]: 0.5,
      [liar.signer_id]: 0.5,
    });
    const r = mergeConflicts([honest, liar], trust, "consensus");
    // Equal weight → LWW picks the later recorded_at.
    expect(r.merged[0].id).toBe(liar.id);
  });

  it("negative trust clamps to 0 (does not boost liar by going 'less negative')", () => {
    const trust = trustMap({
      [honest.signer_id]: 0.01,
      [liar.signer_id]: -1,
    });
    const r = mergeConflicts([honest, liar], trust, "consensus");
    // honest has positive clamped weight, liar clamped to 0 → honest wins.
    expect(r.merged[0].id).toBe(honest.id);
  });
});

describe("merge: multiple groups", () => {
  it("processes independent conflict groups independently", () => {
    const s1a = mkBelief({
      subject: "A",
      predicate: "p",
      object: "x",
      id: "1".padEnd(64, "0"),
      signer_id: "a".repeat(64),
    });
    const s1b = mkBelief({
      subject: "A",
      predicate: "p",
      object: "y",
      id: "2".padEnd(64, "0"),
      signer_id: "b".repeat(64),
    });
    const s2 = mkBelief({
      subject: "B",
      predicate: "p",
      object: "z",
      id: "3".padEnd(64, "0"),
      signer_id: "c".repeat(64),
    });
    const r = mergeConflicts([s1a, s1b, s2], neutralTrust, "consensus");
    // Group A has a conflict, group B does not.
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].subject).toBe("A");
    expect(r.merged).toHaveLength(2);
  });
});
