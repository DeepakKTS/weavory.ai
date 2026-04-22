/**
 * scripts/bench/throughput.ts
 *
 * Standalone throughput benchmark. Writes ops/data/bench.json with real
 * numbers from this run so the dashboard can surface them truthfully.
 * Run with `pnpm bench` (see package.json).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { EngineState } from "../../src/engine/state.js";
import { believe, recall, subscribe } from "../../src/engine/ops.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = resolve(REPO_ROOT, "ops/data/bench.json");

type Result = {
  name: string;
  iterations: number;
  total_ms: number;
  per_op_us: number;
  ops_per_sec: number;
  note: string;
};

function timed(
  name: string,
  iterations: number,
  note: string,
  fn: () => void
): Result {
  const t0 = performance.now();
  fn();
  const dt = performance.now() - t0;
  return {
    name,
    iterations,
    total_ms: Math.round(dt * 100) / 100,
    per_op_us: Math.round((dt * 1000) / iterations),
    ops_per_sec: Math.round(iterations / (dt / 1000)),
    note,
  };
}

function benchBelieve(n: number): Result {
  const s = new EngineState();
  // Warmup
  for (let i = 0; i < 10; i++) {
    believe(s, { subject: `w${i}`, predicate: "p", object: i, signer_seed: "w" });
  }
  return timed(
    "believe",
    n,
    `${n} signed beliefs with shared alice seed; includes Ed25519 sign + BLAKE3 id + store + audit append + subscription fan-out (no subscriptions)`,
    () => {
      for (let i = 0; i < n; i++) {
        believe(s, {
          subject: `scene:${i}`,
          predicate: i % 2 === 0 ? "even" : "odd",
          object: { i, payload: "x".repeat(64) },
          signer_seed: "alice-bench",
        });
      }
    }
  );
}

function benchRecallEmpty(n: number, queries: number): Result {
  const s = new EngineState();
  for (let i = 0; i < n; i++) {
    believe(s, {
      subject: `scene:${i}`,
      predicate: "p",
      object: { i, payload: "x".repeat(64) },
      signer_seed: "alice-bench",
    });
  }
  const signerId = [...s.beliefs.values()][0].signer_id;
  s.setTrust(signerId, "p", 0.9);
  return timed(
    "recall_empty_query",
    queries,
    `${queries} empty-query recalls over ${n} stored beliefs; lazy blob skips JSON.stringify of each belief.object`,
    () => {
      for (let i = 0; i < queries; i++) recall(s, { query: "", top_k: 50 });
    }
  );
}

function benchRecallFiltered(n: number, queries: number): Result {
  const s = new EngineState();
  for (let i = 0; i < n; i++) {
    believe(s, {
      subject: `scene:${i}`,
      predicate: i % 2 === 0 ? "even" : "odd",
      object: { i },
      signer_seed: "alice-bench",
    });
  }
  const signerId = [...s.beliefs.values()][0].signer_id;
  s.setTrust(signerId, "even", 0.9);
  s.setTrust(signerId, "odd", 0.9);
  return timed(
    "recall_with_query",
    queries,
    `${queries} recall("even") queries over ${n} stored beliefs; subject/predicate prefilter short-circuits before stringifying object`,
    () => {
      for (let i = 0; i < queries; i++) recall(s, { query: "even", top_k: 50 });
    }
  );
}

function benchFanout(n: number, subs: number): Result {
  const s = new EngineState();
  for (let i = 0; i < subs; i++) {
    subscribe(s, { pattern: "", filters: { predicate: "even" } });
  }
  subscribe(s, { pattern: "" }); // one unfiltered catch-all
  return timed(
    "believe_with_fanout",
    n,
    `${n} beliefs with ${subs} predicate-filtered subscriptions + 1 unfiltered; indexed fan-out should keep overhead constant w.r.t. bucket miss`,
    () => {
      for (let i = 0; i < n; i++) {
        believe(s, {
          subject: `scene:${i}`,
          predicate: i % 2 === 0 ? "even" : "odd",
          object: { i },
          signer_seed: "alice-bench",
        });
      }
    }
  );
}

function main(): void {
  console.log("[bench] weavory.ai · throughput smoke-bench");

  const results: Result[] = [];
  results.push(benchBelieve(1000));
  results.push(benchRecallEmpty(1000, 200));
  results.push(benchRecallFiltered(1000, 200));
  results.push(benchFanout(1000, 10));

  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(22)}  ${String(r.iterations).padStart(6)} ops  ` +
        `${String(r.total_ms).padStart(8)} ms  ` +
        `${String(r.per_op_us).padStart(6)} µs/op  ` +
        `${String(r.ops_per_sec).padStart(7)} ops/sec`
    );
  }

  const doc = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    runner: `local/${process.platform}-${process.arch}/node-${process.version}`,
    results,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, OUT);
  console.log(`[bench] wrote ${OUT}`);
}

main();
