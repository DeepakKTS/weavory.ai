/**
 * Integration — persistence end-to-end.
 *
 * Validates the full write → close → reopen cycle that models a real restart:
 * an engine emits signed beliefs, attestations, and a tombstone; the
 * PersistentStore records everything; a fresh EngineState rehydrates those
 * records via `restoreFromRecords`; the audit chain verifies; and a recall
 * against the rehydrated state returns the same beliefs the original engine
 * would have returned.
 *
 * This test intentionally does NOT spawn a child process. A same-process
 * "first session → close → second session" cycle is mechanically identical
 * to a restart for JSONL (the backing files are flushed by the synchronous
 * writes) and keeps the test hermetic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineState } from "../../src/engine/state.js";
import { attest, believe, forget, recall } from "../../src/engine/ops.js";
import { openJsonlStore } from "../../src/store/persist_jsonl.js";

let dir: string;
const logger = (_m: string): void => { /* swallow in tests */ };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "weavory-persist-int-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("persistence — restart cycle", () => {
  it("full lifecycle across restart: believe → attest → restart → recall finds the belief", () => {
    // --- session 1 ---
    const s1 = new EngineState();
    s1.attachPersist(openJsonlStore({ dataDir: dir, logger }));

    const b = believe(s1, {
      subject: "scene:rome",
      predicate: "observation",
      object: { congested: true },
      signer_seed: "alice-persist",
    });
    attest(s1, {
      signer_id: b.signer_id,
      topic: "observation",
      score: 0.8,
      attestor_seed: "bob-persist",
    });
    const audit1 = s1.audit.length();
    const beliefs1 = s1.beliefs.size;

    // --- simulated kill: drop all references, reopen store, fresh state ---
    const s2 = new EngineState();
    const store2 = openJsonlStore({ dataDir: dir, logger });
    const loaded = store2.load();
    const verify = s2.restoreFromRecords({
      beliefs: loaded.beliefs,
      audit: loaded.audit,
      trust: loaded.trust,
    });
    s2.attachPersist(store2);

    expect(verify.ok).toBe(true);
    expect(s2.beliefs.size).toBe(beliefs1);
    expect(s2.audit.length()).toBe(audit1);
    expect(s2.trustScore(b.signer_id, "observation")).toBe(0.8);

    // --- recall on the rehydrated state finds the original belief ---
    const out = recall(s2, { query: "rome", top_k: 5 });
    expect(out.beliefs).toHaveLength(1);
    expect(out.beliefs[0].id).toBe(b.id);
  });

  it("tombstones survive restart: forget in s1 → recall in s2 default-view excludes it", () => {
    const s1 = new EngineState();
    s1.attachPersist(openJsonlStore({ dataDir: dir, logger }));

    const b = believe(s1, {
      subject: "scene:paris",
      predicate: "observation",
      object: { foggy: true },
      signer_seed: "alice-p",
    });
    attest(s1, {
      signer_id: b.signer_id,
      topic: "observation",
      score: 0.8,
      attestor_seed: "bob-p",
    });
    forget(s1, { belief_id: b.id, forgetter_seed: "alice-p" });

    // restart
    const s2 = new EngineState();
    const store2 = openJsonlStore({ dataDir: dir, logger });
    const loaded = store2.load();
    s2.restoreFromRecords({
      beliefs: loaded.beliefs,
      audit: loaded.audit,
      trust: loaded.trust,
    });

    const out = recall(s2, { query: "paris", top_k: 5 });
    expect(out.beliefs).toHaveLength(0); // invalidated_at is set → excluded from live view
  });

  it("rehydrate does NOT re-write to disk (no duplicate audit entries across two restarts)", () => {
    // Arrange: write a single belief.
    const s1 = new EngineState();
    s1.attachPersist(openJsonlStore({ dataDir: dir, logger }));
    believe(s1, {
      subject: "scene:berlin",
      predicate: "observation",
      object: { sunny: true },
      signer_seed: "alice-b",
    });

    // Cycle 1: restore into s2, then write nothing, then close.
    const s2 = new EngineState();
    const store2 = openJsonlStore({ dataDir: dir, logger });
    const loaded2 = store2.load();
    s2.restoreFromRecords({
      beliefs: loaded2.beliefs,
      audit: loaded2.audit,
      trust: loaded2.trust,
    });
    s2.attachPersist(store2);

    // Cycle 2: reload a third time. If rehydrate had appended anything,
    // audit.length() here would have doubled. It must not.
    const s3 = new EngineState();
    const store3 = openJsonlStore({ dataDir: dir, logger });
    const loaded3 = store3.load();
    s3.restoreFromRecords({
      beliefs: loaded3.beliefs,
      audit: loaded3.audit,
      trust: loaded3.trust,
    });

    expect(s3.audit.length()).toBe(1);
    expect(s3.beliefs.size).toBe(1);
  });
});
