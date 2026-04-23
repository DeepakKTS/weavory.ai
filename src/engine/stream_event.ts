/**
 * weavory.ai — stream event (Phase N.1 · v0.1.15)
 *
 * Public, read-only descriptor emitted by the engine after each op completes.
 * A sidecar (the dashboard SSE server at `scripts/serve-dashboard.ts`) attaches
 * to `state.onEvent` to forward these frames to connected browsers. The core
 * engine, MCP wire protocol, and persistence paths remain untouched — events
 * are a fan-out concern, not a control-flow change.
 *
 * Design invariants:
 *  - Zero-cost when unsubscribed. `state.onEvent` is optional; `emitStreamEvent`
 *    short-circuits if it is undefined.
 *  - Emitted strictly AFTER `state.onOp?.(...)`, so `runtime_writer.ts` (the
 *    truthful-status dashboard data path) always observes the op first.
 *  - Listener exceptions are caught and logged at most once per 60 s per
 *    process. A misbehaving dashboard must never corrupt engine state or
 *    kill the MCP server.
 *  - Payload carries only public-safe fields. Private keys, raw signer seeds,
 *    full audit hashes (>32 chars), and sub-second `recorded_at` precision
 *    are deliberately excluded.
 */

import type { StoredBelief } from "../core/schema.js";
import type { Subscription } from "./state.js";

/** Discriminated-union kinds emitted by the engine. `recall` is read-only and
 *  not emitted; the dashboard inspects state via snapshot endpoints instead. */
export type StreamEventKind =
  | "believe"
  | "forget"
  | "attest"
  | "subscribe"
  | "quarantine";

/**
 * One event frame. All fields are present on every kind; `confidence` and
 * `trust_after` are optional and populated where they have meaning.
 *
 * Field repurposing across kinds:
 *  - `believe` / `quarantine` → subject/predicate/signer_short reflect the
 *    incoming belief; `confidence` is the signer's calibration; `trust_after`
 *    is the signer's current trust for this predicate.
 *  - `forget` → belief_id_prefix + subject/predicate reflect the tombstoned
 *    belief (read from state before tombstoning); `signer_short` is the
 *    forgetter; confidence/trust_after omitted.
 *  - `attest` → subject is the short form of the TARGET signer being attested;
 *    predicate is the topic; signer_short is the ATTESTOR; `trust_after` is
 *    the new score; `confidence` omitted.
 *  - `subscribe` → belief_id_prefix is the subscription_id (8-hex suffix);
 *    subject is the pattern (truncated); predicate is `filters.predicate ?? "*"`;
 *    signer_short is the subscriber or "anonymous"; confidence/trust_after omitted.
 */
export type StreamEvent = {
  kind: StreamEventKind;
  /** First 16 hex chars of the belief/audit/subscription identifier. */
  belief_id_prefix: string;
  /** Belief subject, or kind-specific override (see above). */
  subject: string;
  /** Belief predicate, or kind-specific override. */
  predicate: string;
  /** First 12 hex chars of the acting signer_id. 96 bits — collision-resistant
   *  at demo scale. Full signer_id is already public on the `recall` wire. */
  signer_short: string;
  /** Present for `believe` and `quarantine`. 0..1. */
  confidence?: number;
  /** ISO-8601 Zulu, truncated to second precision. */
  timestamp: string;
  /** Present for `believe`, `quarantine`, `attest`. Current trust in [-1, 1]. */
  trust_after?: number;
};

/** First-hex-N slice with safe bounds. Exported for tests. */
export function hexPrefix(hex: string, n: number): string {
  if (hex.length <= n) return hex;
  return hex.slice(0, n);
}

/** Strip sub-second precision from an ISO-8601 Zulu timestamp. */
export function toSecondPrecision(iso: string): string {
  return iso.replace(/\.\d+Z$/u, "Z");
}

export function buildBelieveEvent(
  belief: StoredBelief,
  trust_after: number
): StreamEvent {
  return {
    kind: "believe",
    belief_id_prefix: hexPrefix(belief.id, 16),
    subject: belief.subject,
    predicate: belief.predicate,
    signer_short: hexPrefix(belief.signer_id, 12),
    confidence: belief.confidence,
    timestamp: toSecondPrecision(belief.ingested_at),
    trust_after,
  };
}

export function buildQuarantineEvent(
  belief: StoredBelief,
  trust_after: number
): StreamEvent {
  return {
    kind: "quarantine",
    belief_id_prefix: hexPrefix(belief.id, 16),
    subject: belief.subject,
    predicate: belief.predicate,
    signer_short: hexPrefix(belief.signer_id, 12),
    confidence: belief.confidence,
    timestamp: toSecondPrecision(belief.ingested_at),
    trust_after,
  };
}

export function buildForgetEvent(
  belief: StoredBelief,
  forgetter_id: string,
  invalidated_at: string
): StreamEvent {
  return {
    kind: "forget",
    belief_id_prefix: hexPrefix(belief.id, 16),
    subject: belief.subject,
    predicate: belief.predicate,
    signer_short: hexPrefix(forgetter_id, 12),
    timestamp: toSecondPrecision(invalidated_at),
  };
}

export function buildAttestEvent(
  target_signer_id: string,
  topic: string,
  attestor_id: string,
  new_score: number,
  recorded_at: string
): StreamEvent {
  return {
    kind: "attest",
    belief_id_prefix: hexPrefix(target_signer_id, 16),
    subject: hexPrefix(target_signer_id, 12),
    predicate: topic,
    signer_short: hexPrefix(attestor_id, 12),
    timestamp: toSecondPrecision(recorded_at),
    trust_after: new_score,
  };
}

export function buildSubscribeEvent(sub: Subscription): StreamEvent {
  // Subscription ids look like `sub_<24-hex>`; strip prefix for a clean 16-char id.
  const idHex = sub.id.startsWith("sub_") ? sub.id.slice(4) : sub.id;
  const predicate = sub.filters.predicate ?? "*";
  const signer =
    sub.signer_id === null ? "anonymous---" : hexPrefix(sub.signer_id, 12);
  // Truncate very long pattern strings before they hit the wire.
  const subject = sub.pattern.length > 120 ? sub.pattern.slice(0, 117) + "..." : sub.pattern;
  return {
    kind: "subscribe",
    belief_id_prefix: hexPrefix(idHex, 16),
    subject,
    predicate,
    signer_short: signer,
    timestamp: toSecondPrecision(sub.created_at),
  };
}

// ─── Emit helper ────────────────────────────────────────────────────────

/**
 * Minimum interval (ms) between two stderr logs of a listener exception,
 * per process. Avoids flooding logs when a sidecar is broken.
 */
const EMIT_LOG_WINDOW_MS = 60_000;

let lastEmitLogAt = 0;

/**
 * Fire a stream event on a state object that exposes `onEvent`. Zero cost
 * when `onEvent` is unset. Any exception thrown by the listener is caught
 * and logged at most once per 60 s window — the engine carries on.
 */
export function emitStreamEvent(
  state: { onEvent?: ((event: StreamEvent) => void) | undefined },
  event: StreamEvent
): void {
  const handler = state.onEvent;
  if (handler === undefined) return;
  try {
    handler(event);
  } catch (err) {
    const now = Date.now();
    if (now - lastEmitLogAt >= EMIT_LOG_WINDOW_MS) {
      lastEmitLogAt = now;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[stream_event] listener threw (${event.kind}); suppressing further logs for 60s: ${msg}\n`
      );
    }
  }
}

/** Internal — test-only reset of the log throttle. Not exported from index.ts. */
export function _resetEmitLogThrottle(): void {
  lastEmitLogAt = 0;
}
