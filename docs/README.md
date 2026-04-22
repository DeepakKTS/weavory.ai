# weavory — quickstart

> Short guide for an MCP-capable agent (Claude Desktop, Cursor, or
> any official MCP SDK client) to start using weavory in about 60
> seconds.

## What weavory is

An MCP server that lets two or more AI agents share **signed beliefs**
with trust-aware recall. Five tools, one object ("belief"), nothing
else to learn.

## 1 · Install

Pick any one:

```bash
# Fastest — no clone, no build
npx -y @weavory/mcp start

# Container — multi-arch
docker run -v weavory-data:/data ghcr.io/deepakkts/weavory:latest

# From source
git clone https://github.com/DeepakKTS/weavory.ai.git
cd weavory.ai && pnpm install && pnpm build
```

Requires Node ≥ 20 (for local source). Full env-var reference:
[`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).

## 2 · Start the MCP server

```bash
# Option 1 (if installed from source)
pnpm dev

# Option 2 (built from source)
node dist/cli.js start

# Option 3 (from npm)
npx -y @weavory/mcp start
```

The server speaks MCP over stdio. Point any MCP-capable agent at it.

## 3 · The five tools

| Tool | Purpose | Key arguments |
|------|---------|---------------|
| `weavory.believe` | Write a signed belief | `subject`, `predicate`, `object`, optional `signer_seed`, `confidence`, `valid_from`, `valid_to`, `causes` |
| `weavory.recall` | Retrieve beliefs | `query`, optional `top_k`, `as_of`, `min_trust`, `include_quarantined`, `filters` |
| `weavory.subscribe` | Register a semantic subscription | `pattern`, optional `filters`, `signer_seed` |
| `weavory.attest` | Raise / lower trust for (signer, topic) | `signer_id`, `topic`, `score` ∈ [-1,1], optional `attestor_seed` |
| `weavory.forget` | Tombstone a belief | `belief_id`, optional `reason`, `forgetter_seed` |

**`signer_seed`** is how an agent claims a stable identity without
doing crypto itself. Use `"alice"`, `"bob"`, or any short string; the
server derives a deterministic Ed25519 key from it.

## 4 · 60-second walkthrough

### Scenario

> You are **Bob**. A second agent, **Alice**, may have already
> published a belief about Cambridge traffic. Find it, verify you
> agree, and report whether the city is congested.

### Steps

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

**Expected answer:**
> *"Traffic in cambridge is congested (+14 min)."*

### End-to-end reference

The shipped example [`examples/two_agents_collaborate.ts`](../examples/two_agents_collaborate.ts) runs both Alice and Bob through the above in one process:

```bash
pnpm exec tsx examples/two_agents_collaborate.ts
```

Exits **0** with the demo output:

```
[demo] alice + bob connected
[demo] alice believed <belief-id> (signer=<signer-id>)
[demo] bob attested alice @ 0.8 (entry=<entry-hash>)
[demo] bob recalled 1 belief(s)
[demo] bob independently verified alice's signature ✓
[demo] bob's answer: traffic in cambridge is congested (+14 min)
```

## 5 · Guarantees

- **Every belief is Ed25519-signed.** The `id` is `blake3(canonical_json(payload))` — content-addressed.
- **Every write is audit-chained.** Tampering with any past write invalidates all later chain hashes (verified by `audit.verify()`).
- **Default recall is trust-gated.** Signers with topic trust < 0.3 are filtered unless you pass `min_trust: 0` or `include_quarantined: true`.
- **Bi-temporal queries.** `recall({ as_of: "<ISO-8601>" })` returns the belief state as it was at that instant.
- **Public API is exactly five tools.** No surprise surface.

## 6 · What weavory is not

- Not a vector database. Current recall is substring-match; semantic vector search is on the roadmap.
- Not federated. Multi-node gossip is not shipped; treat one process as the trust boundary.
- Not a production agent runtime. It's the coordination substrate — agents are your code.

## 7 · If something goes wrong

See [`docs/RUNBOOK.md`](./RUNBOOK.md) for operational scenarios (restart, policy denial, incident replay, key rotation).

Live control dashboard (when running locally from source): `pnpm dashboard:serve` → <http://localhost:4317/ops/weavory-dashboard.html>. The dashboard reads only real files; missing data shows "Not collected yet".

---

**Full docs:**
[`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`REAL_WORLD_USAGE.md`](./REAL_WORLD_USAGE.md) · [`INSTALL.md`](./INSTALL.md) · [`DEPLOYMENT.md`](./DEPLOYMENT.md) · [`RUNBOOK.md`](./RUNBOOK.md) · [`COMPLIANCE.md`](./COMPLIANCE.md) · [`SECURITY.md`](./SECURITY.md)
