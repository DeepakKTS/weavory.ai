/**
 * Unit tests — src/core/chain.ts + src/store/audit.ts
 *
 * Covers TEST_MATRIX entries T-C-005 (prev_hash linkage), T-C-006 (tamper
 * detection), T-S-003 (append-only ordering).
 */
import { describe, it, expect } from "vitest";
import { AuditStore } from "../../../src/store/audit.js";
import { GENESIS_PREV_HASH } from "../../../src/core/schema.js";
import { computeEntryHash, makeAuditEntry, verifyChain } from "../../../src/core/chain.js";

const SIGNER = "b".repeat(64);

function rec(i: number) {
  return `2026-04-21T20:00:0${i}.000Z`;
}

describe("audit chain — linkage (T-C-005)", () => {
  it("empty store head returns the genesis sentinel", () => {
    const s = new AuditStore();
    expect(s.head()).toBe(GENESIS_PREV_HASH);
    expect(s.length()).toBe(0);
  });

  it("first entry links to GENESIS_PREV_HASH", () => {
    const s = new AuditStore();
    const e = s.append({
      belief_id: "c".repeat(64),
      signer_id: SIGNER,
      operation: "believe",
      recorded_at: rec(0),
    });
    expect(e.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(s.length()).toBe(1);
  });

  it("each subsequent prev_hash equals the previous entry_hash", () => {
    const s = new AuditStore();
    const a = s.append({
      belief_id: "c".repeat(64),
      signer_id: SIGNER,
      operation: "believe",
      recorded_at: rec(0),
    });
    const b = s.append({
      belief_id: "d".repeat(64),
      signer_id: SIGNER,
      operation: "believe",
      recorded_at: rec(1),
    });
    expect(b.prev_hash).toBe(a.entry_hash);
  });
});

describe("audit chain — append-only ordering (T-S-003)", () => {
  it("length is monotonic and entries are returned in insertion order", () => {
    const s = new AuditStore();
    for (let i = 0; i < 5; i++) {
      s.append({
        belief_id: "e".repeat(60) + String(i).padStart(4, "0"),
        signer_id: SIGNER,
        operation: "believe",
        recorded_at: rec(i),
      });
      expect(s.length()).toBe(i + 1);
    }
    const entries = s.entries();
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].prev_hash).toBe(entries[i - 1].entry_hash);
    }
  });
});

describe("audit chain — tamper detection (T-C-006)", () => {
  it("verifyChain succeeds on an unbroken chain", () => {
    const s = new AuditStore();
    for (let i = 0; i < 3; i++) {
      s.append({
        belief_id: "a".repeat(60) + String(i).padStart(4, "0"),
        signer_id: SIGNER,
        operation: "believe",
        recorded_at: rec(i),
      });
    }
    const r = s.verify();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.length).toBe(3);
  });

  it("detects a mutated belief_id in the middle of the chain", () => {
    const s = new AuditStore();
    for (let i = 0; i < 3; i++) {
      s.append({
        belief_id: "f".repeat(60) + String(i).padStart(4, "0"),
        signer_id: SIGNER,
        operation: "believe",
        recorded_at: rec(i),
      });
    }
    const entries = s.entries();
    // Tamper: change entry[1].belief_id without recomputing hashes.
    entries[1] = { ...entries[1], belief_id: "0".repeat(64) };
    const r = verifyChain(entries);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bad_index).toBe(1);
      expect(r.reason).toBe("entry_hash");
    }
  });

  it("detects a broken prev_hash linkage", () => {
    const s = new AuditStore();
    for (let i = 0; i < 3; i++) {
      s.append({
        belief_id: "f".repeat(60) + String(i).padStart(4, "0"),
        signer_id: SIGNER,
        operation: "believe",
        recorded_at: rec(i),
      });
    }
    const entries = s.entries();
    // Tamper: swap entry[2].prev_hash to something that is a valid hex but wrong.
    entries[2] = { ...entries[2], prev_hash: "9".repeat(64) };
    // Recompute entry[2].entry_hash so only prev_hash linkage is broken.
    entries[2] = {
      ...entries[2],
      entry_hash: computeEntryHash({
        prev_hash: entries[2].prev_hash,
        belief_id: entries[2].belief_id,
        signer_id: entries[2].signer_id,
        operation: entries[2].operation,
        recorded_at: entries[2].recorded_at,
      }),
    };
    const r = verifyChain(entries);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bad_index).toBe(2);
      expect(r.reason).toBe("prev_hash");
    }
  });
});

describe("makeAuditEntry is pure", () => {
  it("produces a schema-valid entry", () => {
    const e = makeAuditEntry({
      prev_hash: GENESIS_PREV_HASH,
      belief_id: "a".repeat(64),
      signer_id: SIGNER,
      operation: "forget",
      recorded_at: rec(0),
    });
    expect(e.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.operation).toBe("forget");
  });
});
