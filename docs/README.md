# weavory.ai — judge runbook

> **For the NandaHack judge.** This page is what a stock OpenClaw-compatible agent reads to complete a two-agent belief-exchange task using weavory. It is deliberately short.

## What weavory is

An MCP server that lets two AI agents share *signed beliefs* with trust-aware recall. Five tools, one object ("belief"), nothing else to learn.

## 1 · Install (three lines, fresh machine)

```bash
git clone https://github.com/DeepakKTS/weavory.ai.git
cd weavory.ai
pnpm install && pnpm build
```

Requires Node ≥ 20 and pnpm ≥ 9. No external services — LanceDB / DuckDB are embedded.

## 2 · Start the MCP server

```bash
pnpm dev           # dev mode (tsx)  — prints nothing to stdout (stdout is MCP)
# or
node dist/cli.js start
```

The server speaks MCP over stdio. Point any MCP-capable agent (Claude, OpenClaw, Cursor, LangGraph, …) at it.

## 3 · The five tools

| Tool | Purpose | Key arguments |
|------|---------|---------------|
| `weavory.believe` | Write a signed belief | `subject`, `predicate`, `object`, optional `signer_seed`, `confidence`, `valid_from`, `valid_to`, `causes` |
| `weavory.recall` | Retrieve beliefs | `query`, optional `top_k`, `as_of`, `min_trust`, `include_quarantined`, `filters` |
| `weavory.subscribe` | Register a semantic subscription | `pattern`, optional `filters`, `signer_seed` |
| `weavory.attest` | Raise/lower trust for (signer, topic) | `signer_id`, `topic`, `score` ∈ [-1,1], optional `attestor_seed` |
| `weavory.forget` | OR-set tombstone a belief | `belief_id`, optional `reason`, `forgetter_seed` |

**`signer_seed`** is how an agent claims a stable identity without doing crypto itself. Use `"alice"`, `"bob"`, or any short string; the server derives a deterministic Ed25519 key from it.

## 4 · 60-second walkthrough (what the judge will ask a stock agent to do)

### Scenario

> You are **Bob**. A second agent, **Alice**, may have already published a belief about Cambridge traffic. Find it, verify you agree, and report whether the city is congested.

### Steps an agent should take

1. `weavory.recall` with `{ "query": "traffic cambridge", "top_k": 5 }`.
   - If `total_matched == 0`, Alice hasn't published yet — wait or ask her to publish.
2. If results exist, pick the top belief. It has the shape:
   ```json
   {
     "id": "…64-hex…",
     "subject": "scenario:traffic-cambridge",
     "predicate": "observation",
     "object": { "congested": true, "eta_delta_min": 14, "signal_source": "field-sensor-7" },
     "signer_id": "…64-hex (Alice)…",
     "signature": "…128-hex…",
     "valid_from": "…", "valid_to": null, "recorded_at": "…",
     "confidence": 1
   }
   ```
3. Call `weavory.attest` with `{ "signer_id": "<alice's signer_id>", "topic": "observation", "score": 0.8 }` so Alice's beliefs clear Bob's default trust gate.
4. Re-call `weavory.recall` — Alice's belief should now appear in Bob's default view.
5. Answer using `belief.object.congested` and `eta_delta_min`.

**Expected answer on Gate 3:**
> *"Traffic in cambridge is congested (+14 min)."*

### End-to-end reference script

[`examples/two_agents_collaborate.ts`](../examples/two_agents_collaborate.ts) runs both Alice and Bob through the above in a single process. Run it:

```bash
pnpm exec tsx examples/two_agents_collaborate.ts
```

The script exits **0 on success** with output:

```
[demo] alice + bob connected
[demo] alice believed <belief-id> (signer=<signer-id>)
[demo] bob attested alice @ 0.8 (entry=<entry-hash>)
[demo] bob recalled 1 belief(s)
[demo] bob independently verified alice's signature ✓
[demo] bob's answer: traffic in cambridge is congested (+14 min)

[demo] ✓ Gate 3 demo complete — two-agent exchange via weavory round-tripped cleanly.
```

Gate 3 verification: `pnpm verify:gate3`.

## 5 · What weavory guarantees

- **Every belief is Ed25519-signed.** The `id` is `blake3(canonical_json(payload))` — content-addressed.
- **Every write is audit-chained.** Tampering with any past write invalidates all later chain hashes (`src/core/chain.ts`, verified by `audit.verify()`).
- **Default recall is trust-gated.** Signers with topic trust < 0.3 are filtered unless you pass `min_trust: 0` or `include_quarantined: true`.
- **Bi-temporal queries.** `recall({ as_of: "<ISO-8601>" })` returns the belief state as it was at that instant — useful for rollback, replay, arena strategy rewind.
- **Public API is exactly five tools.** No surprise surface.

## 6 · What weavory is not

- Not a vector database. LanceDB + DuckDB integration lands post-Gate-7 for scale; for the judge test, the in-memory reference store is enough.
- Not federated. Multi-node gossip (libp2p) is feature-flagged (`WEAVORY_FEDERATION=1`, off by default, Phase G only).
- Not a production agent runtime. It's the coordination substrate — agents are your code.

## 7 · If something goes wrong

- `pnpm verify:gate1` — bootstraps pass? files present?
- `pnpm verify:gate2` — MCP surface green? all five tools callable?
- `pnpm verify:gate3` — two-agent exchange green?
- Live control dashboard: `pnpm dashboard:serve` → http://localhost:4317/ops/weavory-dashboard.html
  - Truthful only: each panel names its data source and shows "Not collected yet" when absent.

Links: full decision log in [`control/DECISIONS.md`](../control/DECISIONS.md); per-task trace in [`control/WORKLOG.md`](../control/WORKLOG.md); architecture details in [`control/MASTER_PLAN.md`](../control/MASTER_PLAN.md).
