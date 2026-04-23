/**
 * Unit tests — src/engine/stream_event.ts (Phase N.1 · v0.1.15)
 *
 * Verifies that the richer `onEvent` hook:
 *   1. Fires with the correct discriminant for every op kind (believe,
 *      subscribe, attest, forget) AND promotes a below-trust-floor believe
 *      to `quarantine`.
 *   2. Emits payloads that pass basic shape checks (prefix widths, second-
 *      precision timestamps, no private-key material, no full hashes).
 *   3. Survives a throwing listener without crashing the engine — a
 *      subsequent op still fires the next event frame and state stays
 *      consistent.
 *   4. Fires strictly AFTER `onOp`, preserving the truthful-runtime.json
 *      data path as the primary status source.
 *   5. Does NOT emit on `recall` — reads are observed via sidecar snapshot
 *      endpoints, not the stream.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EngineState } from "../../../src/engine/state.js";
import { believe, attest, forget, recall, subscribe } from "../../../src/engine/ops.js";
import {
  _resetEmitLogThrottle,
  hexPrefix,
  toSecondPrecision,
  type StreamEvent,
} from "../../../src/engine/stream_event.js";

let state: EngineState;
let events: StreamEvent[];
let opTrace: string[];

beforeEach(() => {
  _resetEmitLogThrottle();
  state = new EngineState();
  events = [];
  opTrace = [];
  state.onOp = (op): void => {
    opTrace.push(`onOp:${op}`);
  };
  state.onEvent = (e): void => {
    opTrace.push(`onEvent:${e.kind}`);
    events.push(e);
  };
});

describe("stream_event — discriminant for every op kind", () => {
  it("fires believe → subscribe → attest → forget with correct kinds", () => {
    const aliceId = state.signerFromSeed("alice").signer_id;
    const { id: beliefId } = believe(state, {
      subject: "demo/hello",
      predicate: "status",
      object: { online: true },
      signer_seed: "alice",
    });
    subscribe(state, { pattern: "status", signer_seed: "alice" });
    attest(state, {
      signer_id: aliceId,
      topic: "status",
      score: 0.9,
      attestor_seed: "bob",
    });
    forget(state, { belief_id: beliefId, forgetter_seed: "alice" });

    const kinds = events.map((e) => e.kind);
    // believe (alice unattested trust=0.5 ≥ default floor 0.3 → believe)
    // then subscribe, attest, forget.
    expect(kinds).toEqual(["believe", "subscribe", "attest", "forget"]);
  });

  it("promotes a below-floor believe to quarantine under adversarial mode", () => {
    state.adversarialMode = true; // raises default floor to 0.6 — unknown signers (0.5) quarantined
    believe(state, {
      subject: "claim/42",
      predicate: "approval",
      object: { status: "approved" },
      signer_seed: "mallet-unattested",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("quarantine");
    expect(events[0]!.trust_after).toBe(0.5); // neutral default for unknown signer
  });
});

describe("stream_event — payload shape + safety", () => {
  it("uses 16-hex belief_id_prefix and 12-hex signer_short and second-precision timestamps, and leaks no private material", () => {
    believe(state, {
      subject: "demo/hello",
      predicate: "status",
      object: { online: true },
      signer_seed: "alice",
    });
    const e = events[0]!;
    expect(e.belief_id_prefix).toMatch(/^[0-9a-f]{16}$/u);
    expect(e.signer_short).toMatch(/^[0-9a-f]{12}$/u);
    // Second-precision ISO-8601 Zulu: no sub-second component.
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    // Payload surface is closed — no rogue key material or raw seed leaked.
    const keys = Object.keys(e).sort();
    expect(keys).toEqual(
      [
        "belief_id_prefix",
        "confidence",
        "kind",
        "predicate",
        "signer_short",
        "subject",
        "timestamp",
        "trust_after",
      ].sort()
    );
    const serialized = JSON.stringify(e);
    expect(serialized).not.toMatch(/private/iu);
    expect(serialized).not.toMatch(/signer_seed/iu);
    expect(serialized).not.toMatch(/alice/iu); // seed string must not echo into payload
  });
});

describe("stream_event — listener exceptions are contained", () => {
  it("engine stays healthy when onEvent throws; the next op still fires its event", () => {
    let throws = true;
    state.onEvent = (e): void => {
      events.push(e);
      if (throws) throw new Error("sidecar boom");
    };
    expect(() =>
      believe(state, {
        subject: "a",
        predicate: "b",
        object: { x: 1 },
        signer_seed: "alice",
      })
    ).not.toThrow();
    expect(events).toHaveLength(1);

    throws = false;
    expect(() =>
      believe(state, {
        subject: "c",
        predicate: "d",
        object: { y: 2 },
        signer_seed: "alice",
      })
    ).not.toThrow();
    expect(events).toHaveLength(2);
    expect(state.beliefs.size).toBe(2); // storage unaffected by listener exception
  });
});

describe("stream_event — ordering: onEvent fires strictly AFTER onOp", () => {
  it("records onOp:believe before onEvent:believe (ditto for each subsequent op)", () => {
    believe(state, {
      subject: "x",
      predicate: "y",
      object: { v: 1 },
      signer_seed: "alice",
    });
    subscribe(state, { pattern: "y", signer_seed: "alice" });
    expect(opTrace).toEqual([
      "onOp:believe",
      "onEvent:believe",
      "onOp:subscribe",
      "onEvent:subscribe",
    ]);
  });
});

describe("stream_event — recall does not emit", () => {
  it("a recall() call does not push a StreamEvent (reads are off-stream)", () => {
    believe(state, {
      subject: "x",
      predicate: "y",
      object: { v: 1 },
      signer_seed: "alice",
    });
    events.length = 0;
    opTrace.length = 0;
    const r = recall(state, { query: "x" });
    expect(r.beliefs.length).toBe(1);
    expect(events).toHaveLength(0);
    expect(opTrace).toEqual(["onOp:recall"]); // onOp still fires (truthful-runtime path)
  });
});

describe("stream_event — pure helpers", () => {
  it("hexPrefix / toSecondPrecision edge cases", () => {
    expect(hexPrefix("abcd", 8)).toBe("abcd");
    expect(hexPrefix("abcdef01abcdef01abcdef01", 16)).toBe("abcdef01abcdef01");
    expect(toSecondPrecision("2026-04-23T17:15:14.823Z")).toBe("2026-04-23T17:15:14Z");
    expect(toSecondPrecision("2026-04-23T17:15:14Z")).toBe("2026-04-23T17:15:14Z");
  });
});
