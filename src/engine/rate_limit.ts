/**
 * weavory.ai — per-signer rate limiter (SEC-07, Phase K follow-up)
 *
 * Fixed-window per-second admission control on write operations, keyed by
 * `signer_id` (the 64-hex Ed25519 public key). Companion to SEC-01 (payload
 * cap) and SEC-02 (subscription cap).
 *
 * Scope:
 *   - Applies to write operations only (believe, subscribe, attest, forget).
 *     Read-only `recall` is exempt; a CPU-bound read flood is a different
 *     surface, already bounded by the belief set size and `top_k`.
 *   - Bucket per `signer_id`: same seed → same bucket across calls; fresh
 *     signers get their own bucket.
 *
 * Defaults:
 *   - Normal mode: 100 req/sec per signer — well above any realistic agent
 *     pipeline (the BFSI demo writes ~6 beliefs in ~20s).
 *   - Adversarial mode (`WEAVORY_ADVERSARIAL=1`): 10 req/sec — tight enough
 *     that a scripted flood is visibly rejected, loose enough for demos.
 *   - Disabled: `WEAVORY_RATE_LIMIT_PER_SIGNER=0`.
 *
 * Algorithm: simple fixed-window counter per signer. When a request arrives:
 *   1. If no bucket or the window has elapsed → open a fresh window at `now`
 *      with count 1 and allow.
 *   2. Else if count < limit → increment and allow.
 *   3. Else → throw RateLimitError with `window_remaining_ms`.
 *
 * Future work (not blocking v0.1.x): eviction / TTL on idle buckets. The
 * bucket map grows to the number of distinct signers seen; for a single
 * process with a bounded agent set this is acceptable.
 */

export const DEFAULT_RATE_LIMIT_PER_SIGNER_NORMAL = 100;
export const DEFAULT_RATE_LIMIT_PER_SIGNER_ADVERSARIAL = 10;

/**
 * Parse `WEAVORY_RATE_LIMIT_PER_SIGNER` from the environment. When unset or
 * empty, returns the mode-appropriate default (normal vs adversarial, driven
 * by `WEAVORY_ADVERSARIAL`). A value of `0` disables the limiter entirely.
 * Malformed input (non-integer, negative, NaN) falls back to the default with
 * a stderr warning — matches the SEC-02 `parseSubscriptionsCap` convention.
 */
export function parseRateLimitPerSigner(env: NodeJS.ProcessEnv): number {
  const raw = (env.WEAVORY_RATE_LIMIT_PER_SIGNER ?? "").trim();
  const adversarial = env.WEAVORY_ADVERSARIAL === "1";
  const defaultValue = adversarial
    ? DEFAULT_RATE_LIMIT_PER_SIGNER_ADVERSARIAL
    : DEFAULT_RATE_LIMIT_PER_SIGNER_NORMAL;
  if (raw.length === 0) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    // Operator misconfiguration: fall back to default and log once (stderr
    // so stdin/stdout stdio MCP transport stays clean).
    process.stderr.write(
      `[weavory] WEAVORY_RATE_LIMIT_PER_SIGNER=${JSON.stringify(raw)} ` +
        `is not a non-negative integer; using default ${defaultValue}.\n`
    );
    return defaultValue;
  }
  return n;
}

/** Thrown when a signer's request rate exceeds the configured limit. */
export class RateLimitError extends Error {
  readonly signer_id: string;
  readonly limit_per_sec: number;
  readonly window_remaining_ms: number;
  constructor(signer_id: string, limit: number, windowRemainingMs: number) {
    super(
      `rate limit exceeded for signer ${signer_id.slice(0, 12)}… ` +
        `(${limit} req/sec, ${windowRemainingMs}ms until window reset). ` +
        `Raise via WEAVORY_RATE_LIMIT_PER_SIGNER or set to 0 to disable.`
    );
    this.name = "RateLimitError";
    this.signer_id = signer_id;
    this.limit_per_sec = limit;
    this.window_remaining_ms = windowRemainingMs;
  }
}

type Bucket = {
  count: number;
  windowStart: number;
};

const WINDOW_MS = 1000;

export class RateLimiter {
  readonly limitPerSec: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(limitPerSec: number) {
    if (!Number.isInteger(limitPerSec) || limitPerSec < 0) {
      throw new Error(
        `RateLimiter: limitPerSec must be a non-negative integer, got ${limitPerSec}`
      );
    }
    this.limitPerSec = limitPerSec;
  }

  /**
   * Admit or reject a request from `signer_id`. Throws RateLimitError if the
   * signer's rate in the current 1-second window exceeds `limitPerSec`.
   * When `limitPerSec === 0` the limiter is disabled and this is a no-op.
   */
  check(signer_id: string): void {
    if (this.limitPerSec === 0) return;
    const now = Date.now();
    const bucket = this.#buckets.get(signer_id);
    if (bucket === undefined || now - bucket.windowStart >= WINDOW_MS) {
      this.#buckets.set(signer_id, { count: 1, windowStart: now });
      return;
    }
    if (bucket.count < this.limitPerSec) {
      bucket.count += 1;
      return;
    }
    const windowRemainingMs = WINDOW_MS - (now - bucket.windowStart);
    throw new RateLimitError(signer_id, this.limitPerSec, windowRemainingMs);
  }

  /** Test helper: current count in the active window for `signer_id` (0 if absent). */
  countFor(signer_id: string): number {
    return this.#buckets.get(signer_id)?.count ?? 0;
  }

  /** Test helper: number of distinct signers tracked. */
  size(): number {
    return this.#buckets.size;
  }
}
