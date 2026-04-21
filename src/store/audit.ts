/**
 * weavory.ai — append-only audit store (in-memory reference implementation)
 *
 * This is the minimum Gate-2-ready store. It enforces:
 *  - append-only ordering
 *  - hash-chain linkage on each append
 *  - verifiable replay via `verifyChain`
 *
 * DuckDB-backed persistence (bi-temporal + analytical queries) lands in
 * W-0022. The in-memory store's interface matches what the persistent store
 * will expose, so swapping later is mechanical.
 */
import {
  GENESIS_PREV_HASH,
  type AuditEntry,
  type AuditOperation,
} from "../core/schema.js";
import { makeAuditEntry, verifyChain, type ChainVerifyResult } from "../core/chain.js";

export class AuditStore {
  #entries: AuditEntry[] = [];

  /** Most recent entry_hash, or the genesis sentinel if the store is empty. */
  head(): string {
    return this.#entries.length === 0
      ? GENESIS_PREV_HASH
      : this.#entries[this.#entries.length - 1].entry_hash;
  }

  /** Number of entries in the chain. */
  length(): number {
    return this.#entries.length;
  }

  /** Append a new entry, linked to the current head. */
  append(input: {
    belief_id: string;
    signer_id: string;
    operation: AuditOperation;
    recorded_at: string;
  }): AuditEntry {
    const entry = makeAuditEntry({
      prev_hash: this.head(),
      belief_id: input.belief_id,
      signer_id: input.signer_id,
      operation: input.operation,
      recorded_at: input.recorded_at,
    });
    this.#entries.push(entry);
    return entry;
  }

  /** Defensive copy of all entries. */
  entries(): AuditEntry[] {
    return this.#entries.slice();
  }

  verify(): ChainVerifyResult {
    return verifyChain(this.#entries);
  }

  /**
   * Test / adversarial-simulation hook — directly mutate a stored entry so
   * that `verify()` will report the mutation. Production code MUST NOT call
   * this; it exists so wall-arena demos and tamper tests can reproduce a
   * broken chain without a second backend. The underscore prefix + JSDoc
   * are the explicit "do not use" signal.
   * @internal
   */
  _adversarialMutate(index: number, mutator: (e: AuditEntry) => AuditEntry): void {
    if (index < 0 || index >= this.#entries.length) {
      throw new RangeError(`audit mutate: index ${index} out of bounds (length=${this.#entries.length})`);
    }
    this.#entries[index] = mutator(this.#entries[index]);
  }
}
