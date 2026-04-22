/**
 * Unit tests for the JSONL persistence adapter.
 *
 * Covered edge cases:
 *   - happy path: write → load round-trips cleanly
 *   - tombstone overwrite: second write for same id wins on load
 *   - missing data directory is auto-created
 *   - empty file loads as zero records (no warnings)
 *   - meta-only file loads as zero records (no warnings)
 *   - corrupt JSON line is skipped + logged, valid neighbours survive
 *   - schema-valid JSON with wrong shape is skipped via Zod
 *   - truncated last line (simulating crash mid-write) is skipped cleanly
 *   - trust rows: last (signer_id, topic) wins
 *   - audit entries preserve strict append order
 *   - factory from env helpers resolves defaults correctly
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openJsonlStore } from "../../../src/store/persist_jsonl.js";
import {
  dataDirFromEnv,
  kindFromEnv,
  persistEnabledFromEnv,
  type PersistedTrust,
} from "../../../src/store/persist.js";
import type { AuditEntry, StoredBelief } from "../../../src/core/schema.js";

// ---------- fixtures ----------

const ZERO_HASH = "0".repeat(64);
const SIGNER_A = "aa".repeat(32);
const SIGNATURE = "bb".repeat(64);

function makeBelief(id: string, predicate = "p", invalidated = false): StoredBelief {
  return {
    schema_version: "1.0.0",
    subject: "s",
    predicate,
    object: { x: 1 },
    confidence: 0.9,
    valid_from: null,
    valid_to: null,
    recorded_at: "2026-04-22T00:00:00Z",
    signer_id: SIGNER_A,
    causes: [],
    id,
    signature: SIGNATURE,
    ingested_at: "2026-04-22T00:00:01Z",
    invalidated_at: invalidated ? "2026-04-22T00:01:00Z" : null,
    invalidated_by: invalidated ? id : null,
    quarantined: false,
    quarantine_reason: null,
  };
}

function makeAudit(belief_id: string, entry_hash: string, prev_hash: string): AuditEntry {
  return {
    entry_hash,
    prev_hash,
    belief_id,
    signer_id: SIGNER_A,
    operation: "believe",
    recorded_at: "2026-04-22T00:00:00Z",
  };
}

// ---------- test scaffolding ----------

let tmpDir: string;
const captured: string[] = [];
const logger = (m: string): void => {
  captured.push(m);
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "weavory-persist-"));
  captured.length = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- tests ----------

describe("persist_jsonl — happy path", () => {
  it("round-trips a belief through write → load", () => {
    const store = openJsonlStore({ dataDir: tmpDir, logger });
    const b = makeBelief("a".repeat(64));
    store.writeBelief(b);

    const loaded = store.load();
    expect(loaded.beliefs).toHaveLength(1);
    expect(loaded.beliefs[0].id).toBe(b.id);
    expect(loaded.diagnostics.beliefs_read).toBe(1);
    expect(loaded.diagnostics.beliefs_skipped).toBe(0);
    expect(loaded.diagnostics.warnings).toHaveLength(0);
  });

  it("auto-creates the data directory when it does not exist", () => {
    const nested = join(tmpDir, "does", "not", "exist", "yet");
    const store = openJsonlStore({ dataDir: nested, logger });
    store.writeBelief(makeBelief("1".repeat(64)));
    const loaded = store.load();
    expect(loaded.beliefs).toHaveLength(1);
  });

  it("preserves audit append order strictly", () => {
    const store = openJsonlStore({ dataDir: tmpDir, logger });
    const e1 = makeAudit("a".repeat(64), "e1".padEnd(64, "e"), ZERO_HASH);
    const e2 = makeAudit("b".repeat(64), "e2".padEnd(64, "e"), "e1".padEnd(64, "e"));
    const e3 = makeAudit("c".repeat(64), "e3".padEnd(64, "e"), "e2".padEnd(64, "e"));
    store.writeAudit(e1);
    store.writeAudit(e2);
    store.writeAudit(e3);

    const loaded = store.load();
    expect(loaded.audit.map((e) => e.entry_hash)).toEqual([
      "e1".padEnd(64, "e"),
      "e2".padEnd(64, "e"),
      "e3".padEnd(64, "e"),
    ]);
  });

  it("uses last-write-wins for tombstones on the same belief id", () => {
    const store = openJsonlStore({ dataDir: tmpDir, logger });
    const id = "1".repeat(64);
    store.writeBelief(makeBelief(id));
    store.writeBelief(makeBelief(id, "p", true));

    const loaded = store.load();
    expect(loaded.beliefs).toHaveLength(1);
    expect(loaded.beliefs[0].invalidated_at).not.toBeNull();
  });

  it("uses last-write-wins for trust on (signer_id, topic)", () => {
    const store = openJsonlStore({ dataDir: tmpDir, logger });
    const t1: PersistedTrust = {
      signer_id: SIGNER_A,
      topic: "observation",
      score: 0.2,
      recorded_at: "2026-04-22T00:00:00Z",
    };
    const t2: PersistedTrust = { ...t1, score: 0.9, recorded_at: "2026-04-22T01:00:00Z" };
    store.writeTrust(t1);
    store.writeTrust(t2);

    const loaded = store.load();
    expect(loaded.trust).toHaveLength(1);
    expect(loaded.trust[0].score).toBe(0.9);
  });

  it("keeps separate trust entries for distinct (signer, topic) pairs", () => {
    const store = openJsonlStore({ dataDir: tmpDir, logger });
    store.writeTrust({
      signer_id: SIGNER_A,
      topic: "t1",
      score: 0.5,
      recorded_at: "2026-04-22T00:00:00Z",
    });
    store.writeTrust({
      signer_id: SIGNER_A,
      topic: "t2",
      score: -0.5,
      recorded_at: "2026-04-22T00:00:00Z",
    });

    const loaded = store.load();
    expect(loaded.trust).toHaveLength(2);
  });
});

describe("persist_jsonl — empty / meta-only files", () => {
  it("returns empty results and no warnings when files are fresh", () => {
    const store = openJsonlStore({ dataDir: tmpDir, logger });
    const loaded = store.load();
    expect(loaded.beliefs).toHaveLength(0);
    expect(loaded.audit).toHaveLength(0);
    expect(loaded.trust).toHaveLength(0);
    expect(loaded.diagnostics.warnings).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it("does not double-seed meta on re-open", () => {
    openJsonlStore({ dataDir: tmpDir, logger });
    const before = readFileSync(join(tmpDir, "beliefs.jsonl"), "utf8");
    openJsonlStore({ dataDir: tmpDir, logger });
    const after = readFileSync(join(tmpDir, "beliefs.jsonl"), "utf8");
    expect(after).toBe(before);
  });
});

describe("persist_jsonl — corruption handling", () => {
  it("skips a non-JSON line and logs a warning; preserves valid neighbours", () => {
    const store = openJsonlStore({ dataDir: tmpDir, logger });
    store.writeBelief(makeBelief("1".repeat(64)));
    // Manually inject garbage after a valid write — this is what a crash or
    // power loss can leave on disk.
    appendFileSync(join(tmpDir, "beliefs.jsonl"), "{not-valid-json\n");
    store.writeBelief(makeBelief("2".repeat(64)));

    const loaded = store.load();
    expect(loaded.beliefs).toHaveLength(2);
    expect(loaded.diagnostics.beliefs_skipped).toBe(1);
    expect(loaded.diagnostics.warnings[0]).toMatch(/invalid JSON/);
  });

  it("skips a JSON line that fails Zod validation", () => {
    const path = join(tmpDir, "beliefs.jsonl");
    // Seed meta + one bogus record that parses as JSON but isn't a StoredBelief.
    writeFileSync(
      path,
      JSON.stringify({ _meta: { schema_version: "1.0.0", kind: "belief" } }) + "\n" +
        JSON.stringify({ hello: "world" }) + "\n",
      "utf8"
    );

    const store = openJsonlStore({ dataDir: tmpDir, logger });
    const loaded = store.load();
    expect(loaded.beliefs).toHaveLength(0);
    expect(loaded.diagnostics.beliefs_skipped).toBe(1);
    expect(loaded.diagnostics.warnings[0]).toMatch(/schema validation/);
  });

  it("treats a truncated final line exactly like any other invalid JSON", () => {
    const store = openJsonlStore({ dataDir: tmpDir, logger });
    store.writeBelief(makeBelief("1".repeat(64)));
    store.writeBelief(makeBelief("2".repeat(64)));
    // Simulate a crash mid-write: append a truncated half-record with no trailing newline.
    appendFileSync(join(tmpDir, "beliefs.jsonl"), `{"subject":"t","predicate":`);

    const loaded = store.load();
    expect(loaded.beliefs).toHaveLength(2);
    expect(loaded.diagnostics.beliefs_skipped).toBe(1);
  });
});

describe("persist.ts — env helpers", () => {
  it("persistEnabledFromEnv accepts truthy flags", () => {
    expect(persistEnabledFromEnv({ WEAVORY_PERSIST: "1" })).toBe(true);
    expect(persistEnabledFromEnv({ WEAVORY_PERSIST: "true" })).toBe(true);
    expect(persistEnabledFromEnv({ WEAVORY_PERSIST: "on" })).toBe(true);
    expect(persistEnabledFromEnv({ WEAVORY_PERSIST: "yes" })).toBe(true);
  });

  it("persistEnabledFromEnv rejects empty / unset / falsy flags", () => {
    expect(persistEnabledFromEnv({})).toBe(false);
    expect(persistEnabledFromEnv({ WEAVORY_PERSIST: "" })).toBe(false);
    expect(persistEnabledFromEnv({ WEAVORY_PERSIST: "0" })).toBe(false);
    expect(persistEnabledFromEnv({ WEAVORY_PERSIST: "no" })).toBe(false);
  });

  it("kindFromEnv returns duckdb only on explicit request", () => {
    expect(kindFromEnv({ WEAVORY_STORE: "duckdb" })).toBe("duckdb");
    expect(kindFromEnv({ WEAVORY_STORE: "DuckDB" })).toBe("duckdb");
    expect(kindFromEnv({ WEAVORY_STORE: "jsonl" })).toBe("jsonl");
    expect(kindFromEnv({})).toBe("jsonl");
    expect(kindFromEnv({ WEAVORY_STORE: "sqlite" })).toBe("jsonl"); // unknown → default
  });

  it("dataDirFromEnv defaults to ./.weavory-data", () => {
    expect(dataDirFromEnv({})).toBe("./.weavory-data");
    expect(dataDirFromEnv({ WEAVORY_DATA_DIR: "/var/lib/weavory" })).toBe("/var/lib/weavory");
  });
});

describe("persist_jsonl — survives multi-open cycles (simulated restart)", () => {
  it("two opens with writes in between load identically", () => {
    // First session
    {
      const s = openJsonlStore({ dataDir: tmpDir, logger });
      s.writeBelief(makeBelief("1".repeat(64)));
      s.writeAudit(makeAudit("1".repeat(64), "e1".padEnd(64, "e"), ZERO_HASH));
    }
    // Second session on same dir — writes more
    {
      const s = openJsonlStore({ dataDir: tmpDir, logger });
      s.writeBelief(makeBelief("2".repeat(64)));
      s.writeAudit(makeAudit("2".repeat(64), "e2".padEnd(64, "e"), "e1".padEnd(64, "e")));
    }
    // Third session reads everything
    {
      const s = openJsonlStore({ dataDir: tmpDir, logger });
      const loaded = s.load();
      expect(loaded.beliefs).toHaveLength(2);
      expect(loaded.audit).toHaveLength(2);
      expect(loaded.audit[0].entry_hash).toBe("e1".padEnd(64, "e"));
      expect(loaded.audit[1].entry_hash).toBe("e2".padEnd(64, "e"));
    }
  });

  it("paths inside the returned store are resolved absolute (avoids cwd drift)", () => {
    const s = openJsonlStore({ dataDir: tmpDir, logger });
    expect(s.dataDir).toBe(resolve(tmpDir));
  });
});
