/**
 * Unit tests — src/core/belief.ts + src/core/schema.ts
 *
 * Covers TEST_MATRIX entries T-C-001, T-C-002, plus canonical-encoding
 * determinism and NANDA AgentFacts round-trip.
 */
import { describe, it, expect } from "vitest";
import {
  BeliefPayloadSchema,
  SCHEMA_VERSION,
  type BeliefPayload,
} from "../../../src/core/schema.js";
import {
  agentFactToBelief,
  beliefId,
  beliefToAgentFact,
  buildBelief,
  canonicalBytes,
  canonicalJson,
} from "../../../src/core/belief.js";

const SIGNER = "a".repeat(64); // valid 64-hex-char dummy pubkey for schema tests

describe("canonicalJson", () => {
  it("sorts object keys deterministically", () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 } as unknown as never);
    const b = canonicalJson({ c: 3, a: 2, b: 1 } as unknown as never);
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("preserves array order", () => {
    const s = canonicalJson([3, 1, 2]);
    expect(s).toBe("[3,1,2]");
  });

  it("escapes strings per JSON spec", () => {
    expect(canonicalJson('he said "hi"\n')).toBe('"he said \\"hi\\"\\n"');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN as unknown as never)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY as unknown as never)).toThrow();
  });

  it("drops undefined object values (JSON-strict)", () => {
    const s = canonicalJson({ a: 1, b: undefined as unknown as never, c: 2 } as unknown as never);
    expect(s).toBe('{"a":1,"c":2}');
  });
});

describe("BeliefPayloadSchema (T-C-001, T-C-002)", () => {
  const validPayload: BeliefPayload = {
    schema_version: SCHEMA_VERSION,
    subject: "agent:alice",
    predicate: "knows",
    object: { fact: "the sky is blue" },
    confidence: 0.95,
    valid_from: "2026-04-21T00:00:00Z",
    valid_to: null,
    recorded_at: "2026-04-21T20:00:00Z",
    signer_id: SIGNER,
    causes: [],
  };

  it("accepts a well-formed payload (T-C-001)", () => {
    expect(() => BeliefPayloadSchema.parse(validPayload)).not.toThrow();
  });

  it("rejects a payload missing signer_id (T-C-002)", () => {
    const bad = { ...validPayload } as Partial<BeliefPayload>;
    delete bad.signer_id;
    const r = BeliefPayloadSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects non-ISO-8601 recorded_at", () => {
    const bad = { ...validPayload, recorded_at: "2026-04-21 20:00:00" };
    expect(BeliefPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects confidence outside [0,1]", () => {
    const bad = { ...validPayload, confidence: 1.5 };
    expect(BeliefPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects signer_id with wrong hex length", () => {
    const bad = { ...validPayload, signer_id: "abc" };
    expect(BeliefPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown extra fields (strict)", () => {
    const bad = { ...validPayload, hacker_field: "oops" };
    expect(BeliefPayloadSchema.safeParse(bad).success).toBe(false);
  });
});

describe("buildBelief + beliefId determinism", () => {
  it("produces the same id for the same payload", () => {
    const p1 = buildBelief({
      subject: "agent:alice",
      predicate: "knows",
      object: "hi",
      signer_id: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    });
    const p2 = buildBelief({
      subject: "agent:alice",
      predicate: "knows",
      object: "hi",
      signer_id: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    });
    expect(beliefId(p1)).toBe(beliefId(p2));
  });

  it("changes the id if the object changes", () => {
    const p1 = buildBelief({
      subject: "agent:alice",
      predicate: "knows",
      object: "hi",
      signer_id: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    });
    const p2 = buildBelief({
      subject: "agent:alice",
      predicate: "knows",
      object: "bye",
      signer_id: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    });
    expect(beliefId(p1)).not.toBe(beliefId(p2));
  });

  it("produces a 64-hex-char id (blake3 → 32 bytes)", () => {
    const p = buildBelief({
      subject: "s",
      predicate: "p",
      object: "o",
      signer_id: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    });
    expect(beliefId(p)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalBytes is stable under key reordering of nested objects", () => {
    const p1 = buildBelief({
      subject: "s",
      predicate: "p",
      object: { b: 1, a: 2 },
      signer_id: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    });
    const p2 = buildBelief({
      subject: "s",
      predicate: "p",
      object: { a: 2, b: 1 },
      signer_id: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    });
    const a = Buffer.from(canonicalBytes(p1)).toString("hex");
    const b = Buffer.from(canonicalBytes(p2)).toString("hex");
    expect(a).toBe(b);
  });
});

describe("NANDA AgentFacts interop", () => {
  it("round-trips a minimal AgentFact through belief form", () => {
    const fact = {
      agent_id: "did:nanda:alice",
      fact_type: "has_capability",
      value: "summarize",
      valid_from: "2026-04-21T00:00:00Z",
      valid_to: null,
      signer_pubkey: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    };
    const belief = agentFactToBelief(fact);
    const back = beliefToAgentFact(belief);
    expect(back.agent_id).toBe(fact.agent_id);
    expect(back.fact_type).toBe(fact.fact_type);
    expect(back.value).toBe(fact.value);
    expect(back.valid_from).toBe(fact.valid_from);
    expect(back.valid_to).toBe(fact.valid_to);
    expect(back.signer_pubkey).toBe(fact.signer_pubkey);
    expect(back.confidence).toBe(1);
  });

  it("encodes predicate with agent_fact: prefix", () => {
    const belief = agentFactToBelief({
      agent_id: "did:nanda:bob",
      fact_type: "knows_protocol",
      value: "mcp/1.0",
      signer_pubkey: SIGNER,
      recorded_at: "2026-04-21T20:00:00Z",
    });
    expect(belief.predicate).toBe("agent_fact:knows_protocol");
  });
});
