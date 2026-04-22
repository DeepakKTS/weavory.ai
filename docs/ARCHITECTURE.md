# weavory.ai — Architecture (one page)

> **Goal.** Give a technical reader enough of the mental model in
> 2–3 minutes to follow any feature, demo, or source file.

## What weavory is

A single-process **MCP server** that brokers signed, trust-gated,
hash-chained beliefs between AI agents. Five tools, one object
("belief"), one audit log, one optional persistent store. Nothing
else.

## The layered stack

```
┌────────────────────────────────────────────────────────────────┐
│  Agents (Claude Desktop · Cursor · LangGraph · MCP SDK clients)  │
└──────────────────────────────┬─────────────────────────────────┘
                               │ MCP (stdio, JSON-RPC)
                  ┌────────────┴────────────┐
                  │  src/mcp/server.ts      │   5 tools, Zod-validated
                  │  believe · recall       │   (locked by ADR-005)
                  │  subscribe · attest     │
                  │  forget                 │
                  └────────────┬────────────┘
                               │
    ┌──────────────────────────┴─────────────────────────────────┐
    │                     Engine (in-process)                    │
    │  src/engine/ops.ts       ← tool handlers                   │
    │  src/engine/state.ts     ← EngineState: beliefs, trust,    │
    │                            audit, subscriptions, keyring   │
    │  src/engine/policy.ts    ← pre-believe allow/deny gate     │
    │  src/engine/merge.ts     ← LWW / consensus conflict merge  │
    │  src/engine/incident.ts  ← tamper scan + export            │
    │  src/engine/replay.ts    ← forensic rehydrate + recall     │
    │  src/core/*              ← Ed25519, BLAKE3, schema, chain  │
    └────────┬──────────────────────────┬──────────────────────┬─┘
             │                          │                      │
   ┌─────────┴─────────┐    ┌───────────┴──────────┐  ┌────────┴────────┐
   │ Persistence       │    │ Runtime snapshots    │  │ Incident files  │
   │ src/store/        │    │ src/engine/          │  │ ops/data/       │
   │  persist_jsonl.ts │    │  runtime_writer.ts   │  │  incidents/     │
   │  persist_duckdb.ts│    │  → runtime.json      │  │  incident-*.json│
   │  (optional, flag) │    │  (dashboard surface) │  │  (on demand)    │
   └───────────────────┘    └──────────────────────┘  └─────────────────┘
```

Every downward arrow is a one-way dependency. The engine never reaches
up into MCP transport concerns; persistence and runtime writer are
attached side-effects, not consumers.

## The core object: Belief

Defined in [`src/core/schema.ts`](../src/core/schema.ts):

| Field | Meaning |
|-------|---------|
| `subject`, `predicate`, `object` | The claim itself (arbitrary JSON `object`). |
| `confidence` | 0..1 — the signer's own calibration. |
| `valid_from`, `valid_to` | Valid-time bounds (bi-temporal). |
| `recorded_at` | Wall-clock at signing time. |
| `signer_id` | 32-byte Ed25519 public key (hex). |
| `causes[]` | BLAKE3 ids of prior beliefs this one references. |
| `id` | `BLAKE3(canonical_payload)` — content-addressed. |
| `signature` | Ed25519 over canonical payload bytes. |
| + server fields | `ingested_at`, `invalidated_at`, `quarantined`, … |

## The five tools, at a glance

| Tool | One-line semantic |
|------|-------------------|
| `weavory.believe`   | Sign + store + append audit + fan out to subscribers. |
| `weavory.recall`    | Filter by trust + as_of + subject/predicate + quarantine. |
| `weavory.subscribe` | Register a bounded queue keyed on a pattern + filters. |
| `weavory.attest`    | Update `trust(signer, topic)` in `[-1, 1]`. |
| `weavory.forget`    | OR-set tombstone: `invalidated_at` is set, history preserved. |

## Trust + quarantine (why claims don't propagate automatically)

- Trust is a sparse `Map<signer_id, Map<topic, score ∈ [-1, 1]>>`.
  Default neutral = 0.5 when no attestation exists.
- Default `recall` gate: `min_trust = 0.3` (0.6 under
  `WEAVORY_ADVERSARIAL=1`). Beliefs below the floor are filtered
  silently — callers can always pass `min_trust: -1` for an audit view.
- Quarantine is an explicit boolean field (`quarantined`) plus the
  trust gate. Both must clear for a belief to surface in default
  recall.

## The audit chain (tamper evidence)

`src/store/audit.ts` + `src/core/chain.ts`:

```
entry_hash_n = BLAKE3( canonical(
  prev_hash=entry_hash_{n-1},
  belief_id, signer_id, operation, recorded_at
))
```

Genesis `prev_hash` is 32 zero bytes. Any retroactive edit invalidates
every later hash. `audit.verify()` walks the whole chain; a break
reports `bad_index` and a reason. This is what powers:

- `scanForTamper` → `ops/data/runtime.json.tamper_alarm` for the dashboard.
- `exportIncident` → dumps audit + beliefs + trust + sub metadata to
  `ops/data/incidents/incident-<ts>.json`.
- `weavory replay --from <incident>` → rehydrates and re-verifies
  off-process.
- Startup chain-verify under `WEAVORY_PERSIST=1` → CLI exit code 3 on
  break.

## Persistence (optional, dual backend)

Enabled by `WEAVORY_PERSIST=1`. Three files' worth of state survive
restart: `beliefs`, `audit`, `trust`. Two backends behind one
interface (`PersistentStore` in
[`src/store/persist.ts`](../src/store/persist.ts)):

| Backend  | Flag                | Durability on crash | Native deps |
|----------|---------------------|---------------------|-------------|
| JSONL    | default             | `fs.appendFileSync` — line on disk before `believe()` returns. | none |
| DuckDB   | `WEAVORY_STORE=duckdb` | WAL-backed; `SIGKILL` may lose last ms. Ordering still strict. | `@duckdb/node-api` (optional) |

**Graceful fallback.** DuckDB is loaded via dynamic `import()` inside
a try/catch. If the binary can't load for any reason, the factory
logs one stderr warning and transparently returns a JSONL store. This
is the Gate-6 binary-matrix defense (see
[`src/store/persist.ts`](../src/store/persist.ts) + tests).

**Close barrier.** `store.close()` returns `Promise<void>`. For
JSONL, resolves immediately. For DuckDB, resolves after the async
write chain drains — callers can reliably `await close()` to
synchronize.

## Policy hook (pre-ingest governance)

`WEAVORY_POLICY_FILE=/path/to/policy.json` loads a JSON allow/deny
rule set evaluated **before** signing or storing:

```
max_object_bytes → predicate_deny → predicate_allow → subject_deny → subject_allow
```

Glob-prefix or exact match for subjects; exact match for predicates.
Denials throw a structured `PolicyDenialError`; no belief and no
audit entry are recorded.

## Flow example — one `believe()` end to end

```
1. Client sends tool call { subject, predicate, object, signer_seed }
2. MCP Zod-validates the shape
3. Policy gate (optional): allow/deny on size, subject, predicate
4. Cause-chain check: every id in causes[] must be in state.beliefs
5. Derive keypair  (HKDF-SHA256(seed) → Ed25519)
6. Build canonical payload, sign, content-address via BLAKE3
7. state.storeBelief(parsed)  → in-memory Map + persist.writeBelief
8. state.appendAudit(entry)   → hash-chain + persist.writeAudit
9. state.enqueueMatches(b)    → bounded queues on matching subscribers
10. runtime_writer snapshot (debounced 50 ms)
11. Return { id, signer_id, entry_hash, audit_length } to client
```

Every step is exactly one source file; none of them branch on
customer-specific logic. That is the point — weavory is
**coordination plumbing**, not a framework.

## What it does NOT do (deliberate)

- No TLS / HTTP transport — stdio only.
- No auth service — identity is "proof of seed" via signatures.
- No encryption at rest — use filesystem-layer encryption on the data dir.
- No multi-tenant isolation — one process, one data dir.
- No federation — single writer.
- No vector search — substring match; LanceDB is backlog.
- No full state-merging CRDT — G-Set + LWW tombstones + optional
  consensus merge cover current needs.

Each "not" is a named scope boundary, not an accidental gap. See
[`docs/COMPLIANCE.md`](./COMPLIANCE.md) and
[`control/BACKLOG.json`](../control/BACKLOG.json).

## Where to read next

- Judge path: [`docs/README.md`](./README.md)
- Examples: [`examples/`](../examples/) — each one runs end to end
- Operator ops: [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md), [`docs/RUNBOOK.md`](./RUNBOOK.md)
- Scenarios: [`docs/REAL_WORLD_USAGE.md`](./REAL_WORLD_USAGE.md)
- Security: [`docs/COMPLIANCE.md`](./COMPLIANCE.md)
- Visual: [`ops/weavory.ai-overview_steps.html`](../ops/weavory.ai-overview_steps.html)
