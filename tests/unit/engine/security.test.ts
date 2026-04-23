/**
 * Unit tests for the P1-4 security hardening fixes.
 *
 *   SEC-01 · default payload cap when no policy is loaded
 *   SEC-02 · subscription count cap per EngineState
 *   SEC-03 · loadIncident outer-shape Zod guard
 *
 * Covers happy paths, boundary hits, and error taxonomy (the exact custom
 * error classes so callers can `instanceof` without regex-matching).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineState, SubscriptionLimitError, parseSubscriptionsCap } from "../../../src/engine/state.js";
import {
  DEFAULT_MAX_OBJECT_BYTES,
  OversizedPayloadError,
  attest,
  believe,
  forget,
  subscribe,
} from "../../../src/engine/ops.js";
import { compile } from "../../../src/engine/policy.js";
import { loadIncident } from "../../../src/engine/replay.js";
import {
  DEFAULT_RATE_LIMIT_PER_SIGNER_ADVERSARIAL,
  DEFAULT_RATE_LIMIT_PER_SIGNER_NORMAL,
  RateLimitError,
  RateLimiter,
  parseRateLimitPerSigner,
} from "../../../src/engine/rate_limit.js";

// ---------------- SEC-01 ----------------

describe("SEC-01 — default payload cap when no policy loaded", () => {
  it("accepts a small payload (well under 1 MiB)", () => {
    const s = new EngineState();
    const out = believe(s, {
      subject: "scene:small",
      predicate: "observation",
      object: { tiny: true, note: "x".repeat(128) },
      signer_seed: "alice",
    });
    expect(out.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a payload just over DEFAULT_MAX_OBJECT_BYTES with OversizedPayloadError", () => {
    const s = new EngineState();
    // Construct an object whose JSON serialization exceeds 1 MiB.
    // JSON adds ~20 bytes of framing around the string; pad beyond the cap.
    const big = "x".repeat(DEFAULT_MAX_OBJECT_BYTES + 32);
    expect(() =>
      believe(s, {
        subject: "scene:big",
        predicate: "observation",
        object: { big },
        signer_seed: "alice",
      })
    ).toThrow(OversizedPayloadError);
    // The believe must NOT have produced any side effects on the state.
    expect(s.beliefs.size).toBe(0);
    expect(s.audit.length()).toBe(0);
  });

  it("error carries observed_bytes and limit_bytes metadata", () => {
    const s = new EngineState();
    const big = "x".repeat(DEFAULT_MAX_OBJECT_BYTES + 32);
    try {
      believe(s, {
        subject: "scene:big",
        predicate: "observation",
        object: { big },
        signer_seed: "alice",
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OversizedPayloadError);
      if (err instanceof OversizedPayloadError) {
        expect(err.limit_bytes).toBe(DEFAULT_MAX_OBJECT_BYTES);
        expect(err.observed_bytes).toBeGreaterThan(DEFAULT_MAX_OBJECT_BYTES);
      }
    }
  });

  it("policy-driven cap takes precedence (policy MAY allow a larger payload)", () => {
    const s = new EngineState();
    s.attachPolicy(
      compile({ version: "1.0.0", max_object_bytes: 4 * 1024 * 1024 })
    );
    // 2 MiB — over the default 1 MiB, but under the policy's 4 MiB.
    const big = "x".repeat(2 * 1024 * 1024);
    const out = believe(s, {
      subject: "scene:policy",
      predicate: "observation",
      object: { big },
      signer_seed: "alice",
    });
    expect(out.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("policy with a SMALLER max still rejects oversized payloads via PolicyDenialError", () => {
    const s = new EngineState();
    s.attachPolicy(compile({ version: "1.0.0", max_object_bytes: 128 }));
    // Policy's own PolicyDenialError has a different class; we just check
    // that we don't fall through to the default cap and that some error
    // is thrown and nothing is recorded.
    expect(() =>
      believe(s, {
        subject: "scene:small-cap",
        predicate: "observation",
        object: { data: "x".repeat(256) },
        signer_seed: "alice",
      })
    ).toThrow();
    expect(s.beliefs.size).toBe(0);
  });
});

// ---------------- SEC-02 ----------------

describe("SEC-02 — subscription count cap", () => {
  it("parseSubscriptionsCap returns the default when env is empty", () => {
    expect(parseSubscriptionsCap({})).toBe(10_000);
    expect(parseSubscriptionsCap({ WEAVORY_MAX_SUBSCRIPTIONS: "" })).toBe(10_000);
  });

  it("parseSubscriptionsCap parses a positive integer", () => {
    expect(parseSubscriptionsCap({ WEAVORY_MAX_SUBSCRIPTIONS: "5" })).toBe(5);
    expect(parseSubscriptionsCap({ WEAVORY_MAX_SUBSCRIPTIONS: "1" })).toBe(1);
  });

  it("parseSubscriptionsCap rejects garbage with a warning + default fallback", () => {
    // stderr noise is fine here; we just assert the numeric fallback.
    expect(parseSubscriptionsCap({ WEAVORY_MAX_SUBSCRIPTIONS: "abc" })).toBe(10_000);
    expect(parseSubscriptionsCap({ WEAVORY_MAX_SUBSCRIPTIONS: "0" })).toBe(10_000);
    expect(parseSubscriptionsCap({ WEAVORY_MAX_SUBSCRIPTIONS: "-3" })).toBe(10_000);
    expect(parseSubscriptionsCap({ WEAVORY_MAX_SUBSCRIPTIONS: "1.5" })).toBe(10_000);
  });

  it("rejects a subscribe that would exceed the cap with SubscriptionLimitError", () => {
    const s = new EngineState();
    // We cannot reassign `subscriptionsCap` on a real EngineState without
    // mocking; use Object.defineProperty to override just for this test.
    Object.defineProperty(s, "subscriptionsCap", { value: 2, configurable: true });

    // Two successful subscribes consume the cap.
    subscribe(s, { pattern: "a" });
    subscribe(s, { pattern: "b" });
    expect(s.subscriptions.size).toBe(2);

    // Third must throw with the typed error.
    expect(() => subscribe(s, { pattern: "c" })).toThrow(SubscriptionLimitError);
    expect(s.subscriptions.size).toBe(2);
  });

  it("under-cap subscribes continue to succeed normally", () => {
    const s = new EngineState();
    Object.defineProperty(s, "subscriptionsCap", { value: 100, configurable: true });
    for (let i = 0; i < 10; i++) subscribe(s, { pattern: `p-${i}` });
    expect(s.subscriptions.size).toBe(10);
  });
});

// ---------------- SEC-07 ----------------

/** Helper: build an EngineState with a specific rate-limit-per-sec override. */
function stateWithRateLimit(limitPerSec: number): EngineState {
  const s = new EngineState();
  Object.defineProperty(s, "rateLimiter", {
    value: new RateLimiter(limitPerSec),
    configurable: true,
  });
  return s;
}

describe("SEC-07 — per-signer rate limiter", () => {
  describe("parseRateLimitPerSigner", () => {
    it("returns the normal default when no env overrides are set", () => {
      expect(parseRateLimitPerSigner({})).toBe(DEFAULT_RATE_LIMIT_PER_SIGNER_NORMAL);
      expect(parseRateLimitPerSigner({ WEAVORY_RATE_LIMIT_PER_SIGNER: "" })).toBe(
        DEFAULT_RATE_LIMIT_PER_SIGNER_NORMAL
      );
    });

    it("returns the adversarial default when WEAVORY_ADVERSARIAL=1", () => {
      expect(parseRateLimitPerSigner({ WEAVORY_ADVERSARIAL: "1" })).toBe(
        DEFAULT_RATE_LIMIT_PER_SIGNER_ADVERSARIAL
      );
    });

    it("honours an explicit positive integer", () => {
      expect(parseRateLimitPerSigner({ WEAVORY_RATE_LIMIT_PER_SIGNER: "5" })).toBe(5);
    });

    it("honours an explicit 0 (disabled) — overrides adversarial default", () => {
      expect(
        parseRateLimitPerSigner({ WEAVORY_RATE_LIMIT_PER_SIGNER: "0", WEAVORY_ADVERSARIAL: "1" })
      ).toBe(0);
    });

    it("falls back to default on malformed input (non-integer, negative, NaN)", () => {
      expect(parseRateLimitPerSigner({ WEAVORY_RATE_LIMIT_PER_SIGNER: "abc" })).toBe(
        DEFAULT_RATE_LIMIT_PER_SIGNER_NORMAL
      );
      expect(parseRateLimitPerSigner({ WEAVORY_RATE_LIMIT_PER_SIGNER: "-3" })).toBe(
        DEFAULT_RATE_LIMIT_PER_SIGNER_NORMAL
      );
      expect(parseRateLimitPerSigner({ WEAVORY_RATE_LIMIT_PER_SIGNER: "1.5" })).toBe(
        DEFAULT_RATE_LIMIT_PER_SIGNER_NORMAL
      );
    });
  });

  describe("enforcement on believe()", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("allows up to limitPerSec writes in a single window, then throws", () => {
      const s = stateWithRateLimit(3);
      for (let i = 0; i < 3; i++) {
        believe(s, {
          subject: `scene:${i}`,
          predicate: "observation",
          object: { i },
          signer_seed: "alice",
        });
      }
      expect(() =>
        believe(s, {
          subject: "scene:over",
          predicate: "observation",
          object: { over: true },
          signer_seed: "alice",
        })
      ).toThrow(RateLimitError);
      // Rejected write left no trace.
      expect(s.beliefs.size).toBe(3);
    });

    it("re-admits after the 1-second window rolls over", () => {
      const s = stateWithRateLimit(2);
      believe(s, { subject: "a", predicate: "p", object: 1, signer_seed: "alice" });
      believe(s, { subject: "b", predicate: "p", object: 2, signer_seed: "alice" });
      expect(() =>
        believe(s, { subject: "c", predicate: "p", object: 3, signer_seed: "alice" })
      ).toThrow(RateLimitError);

      // Advance past the 1-second window.
      vi.advanceTimersByTime(1001);

      believe(s, { subject: "d", predicate: "p", object: 4, signer_seed: "alice" });
      expect(s.beliefs.size).toBe(3);
    });

    it("per-signer isolation — alice rate-limited, bob proceeds", () => {
      const s = stateWithRateLimit(2);
      believe(s, { subject: "a1", predicate: "p", object: 1, signer_seed: "alice" });
      believe(s, { subject: "a2", predicate: "p", object: 2, signer_seed: "alice" });
      expect(() =>
        believe(s, { subject: "a3", predicate: "p", object: 3, signer_seed: "alice" })
      ).toThrow(RateLimitError);
      // bob has his own bucket.
      believe(s, { subject: "b1", predicate: "p", object: 1, signer_seed: "bob" });
      believe(s, { subject: "b2", predicate: "p", object: 2, signer_seed: "bob" });
      expect(s.beliefs.size).toBe(4);
    });

    it("disabled (limitPerSec=0) lets unlimited writes through", () => {
      const s = stateWithRateLimit(0);
      for (let i = 0; i < 500; i++) {
        believe(s, {
          subject: `scene:${i}`,
          predicate: "p",
          object: { i },
          signer_seed: "alice",
        });
      }
      expect(s.beliefs.size).toBe(500);
    });

    it("RateLimitError carries signer_id, limit, and window_remaining_ms", () => {
      const s = stateWithRateLimit(1);
      believe(s, { subject: "a", predicate: "p", object: 1, signer_seed: "alice" });
      try {
        believe(s, { subject: "b", predicate: "p", object: 2, signer_seed: "alice" });
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        if (err instanceof RateLimitError) {
          expect(err.signer_id).toMatch(/^[0-9a-f]{64}$/);
          expect(err.limit_per_sec).toBe(1);
          expect(err.window_remaining_ms).toBeGreaterThan(0);
          expect(err.window_remaining_ms).toBeLessThanOrEqual(1000);
        }
      }
    });
  });

  describe("enforcement on attest() and forget()", () => {
    it("attest() rate-limits the attestor", () => {
      const s = stateWithRateLimit(2);
      attest(s, {
        signer_id: "0".repeat(64),
        topic: "news",
        score: 0.5,
        attestor_seed: "judge",
      });
      attest(s, {
        signer_id: "0".repeat(64),
        topic: "news",
        score: 0.6,
        attestor_seed: "judge",
      });
      expect(() =>
        attest(s, {
          signer_id: "0".repeat(64),
          topic: "news",
          score: 0.7,
          attestor_seed: "judge",
        })
      ).toThrow(RateLimitError);
    });

    it("forget() rate-limits the forgetter", () => {
      const s = stateWithRateLimit(1);
      // Two beliefs to potentially forget.
      const b1 = believe(s, {
        subject: "a",
        predicate: "p",
        object: 1,
        signer_seed: "writer-1",
      });
      const b2 = believe(s, {
        subject: "b",
        predicate: "p",
        object: 2,
        signer_seed: "writer-2",
      });
      // First forget from "eraser" — consumes the one slot for that signer.
      forget(s, { belief_id: b1.id, forgetter_seed: "eraser" });
      expect(() =>
        forget(s, { belief_id: b2.id, forgetter_seed: "eraser" })
      ).toThrow(RateLimitError);
    });
  });

  describe("RateLimiter direct API", () => {
    it("constructor rejects negative or non-integer limits", () => {
      expect(() => new RateLimiter(-1)).toThrow();
      expect(() => new RateLimiter(1.5)).toThrow();
      // Zero is allowed (disabled).
      expect(() => new RateLimiter(0)).not.toThrow();
    });

    it("countFor and size report bucket state accurately", () => {
      const rl = new RateLimiter(10);
      const a = "a".repeat(64);
      const b = "b".repeat(64);
      expect(rl.size()).toBe(0);
      rl.check(a);
      rl.check(a);
      rl.check(b);
      expect(rl.countFor(a)).toBe(2);
      expect(rl.countFor(b)).toBe(1);
      expect(rl.size()).toBe(2);
    });
  });
});

// ---------------- SEC-03 ----------------

describe("SEC-03 — loadIncident outer-shape guard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "weavory-load-incident-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(filename: string, payload: unknown): string {
    const path = join(dir, filename);
    writeFileSync(path, JSON.stringify(payload), "utf8");
    return path;
  }

  it("preserves the 'unsupported schema_version' error taxonomy for version mismatches", () => {
    const p = write("wrong-version.json", { schema_version: "2.0.0" });
    expect(() => loadIncident(p)).toThrow(/unsupported incident schema_version/);
  });

  it("rejects a missing `audit` block with a structured shape-validation error", () => {
    const p = write("no-audit.json", {
      schema_version: "1.0.0",
      incident_id: "incident-X",
      exported_at: "2026-04-22T00:00:00Z",
      beliefs: { total: 0, live: 0, quarantined: 0, tombstoned: 0, records: [] },
    });
    expect(() => loadIncident(p)).toThrow(/failed outer shape validation/);
  });

  it("rejects a missing `beliefs` block", () => {
    const p = write("no-beliefs.json", {
      schema_version: "1.0.0",
      incident_id: "incident-Y",
      exported_at: "2026-04-22T00:00:00Z",
      audit: { length: 0, verify: { ok: true, length: 0 }, entries: [] },
    });
    expect(() => loadIncident(p)).toThrow(/failed outer shape validation/);
  });

  it("rejects a file that isn't valid JSON with a clear JSON error", () => {
    const p = join(dir, "garbage.json");
    writeFileSync(p, "{not-json", "utf8");
    expect(() => loadIncident(p)).toThrow(/not valid JSON/);
  });

  it("rejects a file that doesn't exist with a file-read error", () => {
    const p = join(dir, "does-not-exist.json");
    expect(() => loadIncident(p)).toThrow(/cannot read incident file/);
  });

  it("accepts a minimal well-formed record (round-trip smoke)", () => {
    const p = write("good.json", {
      schema_version: "1.0.0",
      incident_id: "incident-20260422T000000",
      exported_at: "2026-04-22T00:00:00Z",
      reason: null,
      adversarial_mode: false,
      audit: { length: 0, verify: { ok: true, length: 0 }, entries: [] },
      beliefs: { total: 0, live: 0, quarantined: 0, tombstoned: 0, records: [] },
      trust: [],
      subscriptions: [],
    });
    const loaded = loadIncident(p);
    expect(loaded.record.schema_version).toBe("1.0.0");
    expect(loaded.record.audit.length).toBe(0);
    expect(loaded.record.beliefs.total).toBe(0);
  });
});
