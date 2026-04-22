/**
 * weavory.ai — in-memory state branching (Phase G.4, W-0131)
 *
 * `cloneState(src)` returns a deep copy of an EngineState: independent
 * belief map, new AuditStore populated via `restoreEntries`, new trust
 * vectors, new subscriptions (with copied queues and counters), new
 * keyring. The clone DOES NOT inherit the source's `onOp` hook —
 * branches are detached from the runtime writer so a fork can be
 * manipulated freely without polluting the main process's runtime.json.
 *
 * Uses:
 *   - "What if…" strategy forks during gauntlet runs.
 *   - Rehydrating an incident into a pristine engine (src/engine/replay.ts).
 *   - Test harnesses that need to compare two parallel timelines.
 *
 * Cost: O(beliefs + audit + trust + subscriptions). For the in-memory
 * reference sizes we're targeting this is microseconds on modern hardware.
 * The vectors are copied, not shared — no aliasing between branches.
 */
import { EngineState, type Subscription, type TrustVector } from "./state.js";
import type { StoredBelief } from "../core/schema.js";
import type { KeyPair } from "../core/sign.js";

/** Deep-copy a StoredBelief (belief.object can be a nested JsonValue). */
function cloneBelief(b: StoredBelief): StoredBelief {
  return {
    ...b,
    // `object` is a JsonValue — clone via the structured-clone algorithm so
    // nested arrays/objects don't alias between branches.
    object: structuredClone(b.object),
    causes: [...b.causes],
  };
}

function cloneTrustVector(src: TrustVector): TrustVector {
  const dst: TrustVector = new Map();
  for (const [topic, score] of src) dst.set(topic, score);
  return dst;
}

function cloneSubscription(src: Subscription): Subscription {
  return {
    id: src.id,
    pattern: src.pattern,
    filters: { ...src.filters },
    created_at: src.created_at,
    signer_id: src.signer_id,
    matches_since_created: src.matches_since_created,
    queue: src.queue.map(cloneBelief),
    queue_cap: src.queue_cap,
    dropped_count: src.dropped_count,
    last_drained_at: src.last_drained_at,
  };
}

function cloneKeyPair(kp: KeyPair): KeyPair {
  return {
    publicKey: new Uint8Array(kp.publicKey),
    privateKey: new Uint8Array(kp.privateKey),
  };
}

/**
 * Produce a detached deep-copy of `src`. Mutations on the returned state
 * do NOT affect `src`. The branch's `onOp` is intentionally left `undefined`
 * — callers opt in by attaching their own RuntimeWriter if desired.
 */
export function cloneState(src: EngineState): EngineState {
  const dst = new EngineState();

  for (const [id, belief] of src.beliefs) dst.beliefs.set(id, cloneBelief(belief));
  dst.audit.restoreEntries(src.audit.entries());

  for (const [signer, tv] of src.trust) dst.trust.set(signer, cloneTrustVector(tv));

  for (const [sid, sub] of src.subscriptions) dst.subscriptions.set(sid, cloneSubscription(sub));
  // Subscriptions were copied via direct Map.set above; rebuild the
  // predicate-bucket index so fan-out in the branch stays O(1).
  dst.reindexSubscriptions();

  for (const [sid, kp] of src.keyring) dst.keyring.set(sid, cloneKeyPair(kp));

  dst.adversarialMode = src.adversarialMode;
  // onOp is intentionally not copied.

  return dst;
}
