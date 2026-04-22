# weavory.ai — End-to-End Context Guide

> **Purpose.** One document that explains what weavory actually does,
> how it works under the hood, the real-world problems it solves, and
> an honest assessment of where it competes in NandaHack 2026. Written
> to be readable by someone who has never seen the code.

If you only have 60 seconds, read [§ What it is in one paragraph](#what-it-is-in-one-paragraph)
and [§ The five tools, explained](#the-five-tools-explained).

If you're a judge, read §§ 1, 2, 4, 5, and 9.

---

## Table of contents

1. [What it is in one paragraph](#what-it-is-in-one-paragraph)
2. [The five tools, explained](#the-five-tools-explained)
3. [How a belief flows through the system](#how-a-belief-flows-through-the-system)
4. [Worked examples — five scenarios with real output](#worked-examples)
5. [Real-world problems weavory solves](#real-world-problems-weavory-solves)
6. [Persistence: dual-backend architecture](#persistence-dual-backend-architecture)
7. [Policy enforcement: the governance lever](#policy-enforcement)
8. [Edge cases handled (and one deliberately not)](#edge-cases-handled-and-one-deliberately-not)
9. [Hackathon competency — honest assessment](#hackathon-competency--honest-assessment)
10. [What weavory is NOT](#what-weavory-is-not)
11. [Reproducing every claim in this document](#reproducing-every-claim-in-this-document)

---

## What it is in one paragraph

weavory is an **MCP server** that lets two or more AI agents share
**signed beliefs** about the world. Every belief is Ed25519-signed, its
`id` is a BLAKE3 hash of its canonical payload, and every write is
linked into a hash-chained audit log. Agents that want to read beliefs
go through a **trust gate**: low-trust or unsigned claims are
quarantined by default; explicit attestations raise trust. If the audit
log is tampered with, an **alarm** fires and an **incident** is
exported for forensic review. State can be **persisted** either to a
JSONL append log (default) or to DuckDB (opt-in), and a
**pre-belief policy** can reject classes of claims before they're ever
signed. The public API is exactly five MCP tools; nothing else.

That's the whole product.

---

## The five tools, explained

Every MCP-capable agent (Claude Desktop, OpenClaw, Cursor, custom code
using the official MCP SDK) sees these five tools and nothing else:

### 1. `weavory.believe`

*"I'm publishing a claim. Sign it, record it, notify subscribers."*

```typescript
weavory.believe({
  subject: "scene:rome",
  predicate: "observation",
  object: { congested: true, eta_delta_min: 14 },
  confidence: 1,
  signer_seed: "alice"
})
// → { id, signer_id, entry_hash, ingested_at, audit_length }
```

Under the hood: build canonical payload → Ed25519 sign → BLAKE3 id →
append to audit chain → fan out to matching subscriptions.

### 2. `weavory.recall`

*"Show me beliefs that match — but only from signers I trust."*

```typescript
weavory.recall({
  query: "rome traffic",
  top_k: 5,
  min_trust: 0.3,
  as_of: null,                    // or "2026-04-22T00:00:00Z" for time-travel
  include_quarantined: false,
  filters: { predicate: "observation" }
})
// → { beliefs[], total_matched, now, conflicts?, reputation? }
```

Under the hood: iterate beliefs → filter by as_of / tombstone /
quarantine / subject / predicate / trust → score → sort → merge
(optional) → top_k.

### 3. `weavory.subscribe`

*"Notify me whenever a matching belief arrives — I'll pull when ready."*

```typescript
weavory.subscribe({
  pattern: "traffic",
  filters: { predicate: "observation", min_confidence: 0.8 }
})
// → { subscription_id, created_at, signer_id, queue_cap }
```

Under the hood: allocate bounded queue, index by predicate. Later,
`weavory.recall({ subscription_id })` drains the queue.

### 4. `weavory.attest`

*"I'm telling the system how much I trust this signer on this topic."*

```typescript
weavory.attest({
  signer_id: "<alice's hex signer_id>",
  topic: "observation",
  score: 0.8,
  attestor_seed: "bob"
})
// → { signer_id, topic, applied_score, attestor_id, entry_hash }
```

Under the hood: clamp to [-1, 1], update `Map<signer, Map<topic, score>>`,
append audit entry for attributability.

### 5. `weavory.forget`

*"Tombstone this belief — it's wrong or stale, but keep the audit trail."*

```typescript
weavory.forget({
  belief_id: "<64-hex>",
  reason: "superseded",
  forgetter_seed: "alice"
})
// → { belief_id, found, invalidated_at, entry_hash }
```

Under the hood: OR-set-style tombstone (set `invalidated_at`), belief
stays in the store for `as_of` historical queries, live `recall`
excludes it.

---

## How a belief flows through the system

```
┌──────────────┐    weavory.believe       ┌──────────────┐
│  Agent code  │ ───── MCP stdio ───────▶ │  MCP server  │
│ (Claude,...) │                           │  (src/mcp)   │
└──────────────┘                           └──────┬───────┘
                                                  │
                                                  ▼
                                  ┌───────────────────────────┐
                                  │   Zod schema validation   │
                                  └───────┬───────────────────┘
                                          │
                                          ▼
                                  ┌───────────────────────────┐
                     (if set) ───▶│  Pre-believe policy hook  │─── deny → error to client
                                  │  (src/engine/policy.ts)   │
                                  └───────┬───────────────────┘
                                          │ allow
                                          ▼
                                  ┌───────────────────────────┐
                                  │  Causes[] validation      │
                                  │  (unknown id → throw)     │
                                  └───────┬───────────────────┘
                                          │
                                          ▼
                                  ┌───────────────────────────┐
                                  │  HKDF-SHA256(seed)        │
                                  │  → Ed25519 keypair        │
                                  │  → sign canonical bytes   │
                                  │  → BLAKE3 id              │
                                  └───────┬───────────────────┘
                                          │
                                          ▼
                   ┌──────────────────────┴──────────────────────┐
                   ▼                                             ▼
           ┌───────────────┐                           ┌───────────────┐
           │ In-memory Map │                           │  persist?     │─── (optional)
           │  beliefs[id]  │                           │  JSONL append │
           └───────┬───────┘                           │  or DuckDB    │
                   │                                   └───────────────┘
                   ▼
           ┌───────────────┐                           ┌───────────────┐
           │  Audit.append │──── hash-chain linked ───▶│  persist?     │
           │  (BLAKE3)     │                           │  audit write  │
           └───────┬───────┘                           └───────────────┘
                   │
                   ▼
           ┌───────────────┐                           ┌───────────────┐
           │ enqueueMatches│──── predicate bucket ────▶│ Subscribers   │
           │  (fan-out)    │                           │  (queue)      │
           └───────┬───────┘                           └───────────────┘
                   │
                   ▼
           ┌───────────────┐
           │ runtime_writer│──── debounced 50ms ──────▶ ops/data/runtime.json
           │  snapshot     │
           └───────────────┘
                   │
                   ▼
           ┌───────────────┐
           │  Return to    │──── MCP response ────────▶ back to agent
           │  client       │
           └───────────────┘
```

Every arrow labeled "optional" is a feature flag; every arrow is in the
audit log, so the flow is fully reconstructible post-hoc via `weavory
replay`.

---

## Worked examples

All five scenarios below are **real commands** you can run on this
repo right now. Each produces real output, no simulation.

### Example 1 — Two agents coordinate on traffic (Gate 3, the judge path)

**The problem.** Alice and Bob are two agents. Alice has ground-truth
sensor data; Bob needs to answer "is Cambridge traffic bad right now?"
Bob should not trust unsigned noise and should only use Alice's claim
if he's attested to her.

```bash
pnpm exec tsx examples/two_agents_collaborate.ts
```

Output ends with:
```
[demo] alice believed <belief-id>
[demo] bob attested alice @ 0.8 (entry=<hash>)
[demo] bob recalled 1 belief(s)
[demo] bob independently verified alice's signature ✓
[demo] bob's answer: traffic in cambridge is congested (+14 min)
[demo] ✓ Gate 3 demo complete — two-agent exchange via weavory round-tripped cleanly.
```

**Why it matters.** This is exactly what a stock Claude Opus 4.7 agent
does in Gate 7 using only `docs/README.md`. No bespoke glue. The CI
run on commit `6661f76` proved it works on a fresh Ubuntu runner in
27 seconds.

---

### Example 2 — Adversarial drill: someone tampers the audit log (Gate Wall)

**The problem.** An attacker has direct disk access and edits an entry
in the audit chain after it was written. The system must detect this
and export a forensic record.

```bash
pnpm exec tsx examples/wall_incident.ts
```

Output (abridged):
```
[wall] alice published belief <id-1>
[wall] mallet injected malicious belief <id-2>
[wall] attacker tampered entry at index 1 → reason: entry_hash mismatch
[wall] tamper_alarm set in runtime.json
[wall] incident exported → ops/data/incidents/incident-<timestamp>.json
[wall] ✓ Gate Wall complete.
```

**What it proves.** Hash-chain tamper detection actually works. The
exported incident JSON can be reviewed by a human, replayed via
`weavory replay --from <path>`, and the detection reproduces on the
rehydrated state — i.e., the tamper is in the data, not a transient
bug.

---

### Example 3 — Time travel: "what did the system know at 3pm yesterday?" (Gate 5)

**The problem.** A compliance officer needs to reconstruct what beliefs
were "live" at a past point in time — even for beliefs that have since
been retracted via `forget`.

```bash
pnpm exec tsx examples/gauntlet_rewind.ts
```

Output ends with:
```
[rewind] t0: alice believed scene:test (id=<hex>)
[rewind] t1: alice forgot scene:test
[rewind] live recall (t>=t1): 0 beliefs
[rewind] as_of recall (t=t0): 1 belief  ← reconstructed
[rewind] ✓ Gate 5 complete — bi-temporal recall intact.
```

**What it proves.** weavory preserves history — tombstones mask live
recall but don't destroy the record. `recall({ as_of: "<ISO>" })`
reconstructs the world as it was.

---

### Example 4 — Persistence round-trip: "survive a process restart"

**The problem.** In production, a container can be killed at any time.
The substrate must preserve signed beliefs, the audit chain, and trust
attestations across restart — and verify the chain on reboot.

```bash
# Session 1 — write
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/weavory-demo \
  node dist/cli.js start &
# ...connect an MCP client, call weavory.believe, then kill

# Session 2 — restart + verify
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/weavory-demo \
  node dist/cli.js start
# stderr:
#   [weavory] persistence enabled (kind=jsonl dir=/tmp/weavory-demo)
#   [weavory] rehydrated beliefs=1 audit=1 trust=0 verify=ok
```

Call `weavory.recall` on session 2 → the same belief id comes back.

**Extra:** flip to DuckDB with `WEAVORY_STORE=duckdb` — same behavior,
WAL-backed file at `/tmp/weavory-demo/weavory.duckdb`.

---

### Example 5 — Policy denial: "we're regulated; some predicates are off-limits"

**The problem.** A healthcare deployment must block any belief whose
predicate matches `pii.ssn` or `pii.dob`, and must cap payload size to
prevent an agent from stuffing a CSV export into `object`.

Policy file (`/etc/weavory/policy.json`):

```json
{
  "version": "1.0.0",
  "subject_allow": ["scene:*", "patient:*"],
  "predicate_deny": ["pii.ssn", "pii.dob", "internal.secret"],
  "max_object_bytes": 8192
}
```

Start: `WEAVORY_POLICY_FILE=/etc/weavory/policy.json node dist/cli.js start`

Now an agent calls `weavory.believe({ subject: "patient:p-1234",
predicate: "pii.ssn", object: {digits: "..."} })` →

```
Error: policy denial (predicate_deny): predicate "pii.ssn" is on the deny-list
```

No belief recorded. No audit entry. The client sees a structured error
with the rule name so an engineer can diagnose which policy matched.

---

## Real-world problems weavory solves

These are concrete scenarios — not marketing language. Each names the
specific pain point and the weavory feature that addresses it.

### BFSI: multi-agent insurance claims triage

**Pain:** A claim flows through intake → fraud detection → underwriting
→ approval agents. Each agent makes a claim about the case. If one
agent is compromised or miscalibrated, an incorrect approval can cost
six figures. Today there is no audit trail linking each agent's
contribution to a specific signed identity, and no way to reconstruct
"what did the fraud agent say at 3:47 PM?"

**Weavory solves:** every intermediate claim is Ed25519-signed;
`weavory.recall({ as_of })` reconstructs the case file at any past
instant; `WEAVORY_ADVERSARIAL=1` raises the trust floor so a freshly
spawned agent can't approve anything until it's been attested; a
compromised agent's claims can be reviewed via `weavory replay` on
the exported audit chain.

### Healthcare: clinical decision-support agent safety

**Pain:** An LLM-based clinical assistant shares observations between
agents ("this lab result suggests X"). Regulators require attributability
— every decision input must have a traceable source — and the ability to
revoke a claim without destroying the record of it.

**Weavory solves:** Ed25519 signatures bind each observation to a named
signer; `weavory.forget` tombstones without destruction; the bi-temporal
view gives regulators the "point-in-time" reconstruction they need; the
pre-believe policy hook blocks predicates that leak PII.

### Regulated LLM orchestration: catching prompt injection via trust

**Pain:** An attacker successfully prompt-injects one agent. That agent
publishes poisoned beliefs ("the user's API key is X"). Other agents
read and act on those beliefs. Standard memory systems have no trust
model to defend against this.

**Weavory solves:** the compromised agent's beliefs are quarantined
until explicitly attested. In adversarial mode, NEW signers default to
trust 0.5 — below the 0.6 floor — so their beliefs never enter recall
until a trusted attester vouches for them. Even if they do, `weavory.attest`
with `score: -1` (explicit distrust) poisons that signer across the
whole substrate, stopping the cascade.

### Enterprise audit: "what decisions did our agent stack make last week?"

**Pain:** Compliance asks for evidence of every decision made by an
agent pipeline over a 30-day window. Most memory systems can't answer
because they've compacted, garbage-collected, or mutated state.

**Weavory solves:** the audit chain is strictly append-only; no
compaction by default; `weavory.recall({ as_of: "<ISO>" })` reconstructs
live state at any past instant; the JSONL persistence backend is
human-readable so compliance can `cat` the files directly; DuckDB
backend supports SQL analytics over the audit log.

### Developer experience: a coordination layer that isn't a black box

**Pain:** Agent frameworks (LangGraph, CrewAI) have opaque state
machines. Debugging "why did agent B not see agent A's output?" is
guesswork.

**Weavory solves:** every interaction is one of five named operations,
every operation is audit-logged, and `weavory replay` lets you step
through the audit chain offline. There is no hidden state.

---

## Persistence: dual-backend architecture

This is the subsystem most different from other memory layers. Two
backends share one interface.

### JSONL (default, zero native deps)

- `fs.appendFileSync` per write → durable before `believe()` returns.
- Three files: `beliefs.jsonl`, `audit.jsonl`, `trust.jsonl`. Each
  starts with a `{"_meta": ...}` line the parser skips. Subsequent
  lines are one record each.
- **Corruption tolerance:** invalid JSON or schema-invalid records are
  skipped with a warning. A crash mid-write leaves a truncated final
  line; on next load it's skipped exactly like any other invalid line.
- **Last-write-wins on id:** tombstoning a belief just appends a new
  line with `invalidated_at` set. On load, the Map's set semantics
  naturally give you the newest version.
- **Audit is strict append-only** — entries are read in insertion order.

### DuckDB (opt-in via `WEAVORY_STORE=duckdb`)

- Single-file SQLite-style DB at `<data-dir>/weavory.duckdb`.
- Three tables mirror the JSONL layout: `beliefs`, `audit`, `trust`.
- WAL-backed: crash-consistent via DuckDB's own WAL replay.
- Async Node binding → fire-and-forget write queue preserving ORDER.
  Durability tradeoff: SIGKILL can lose the last few ms of writes.
  Documented and acceptable for most use cases.
- **Single-writer invariant enforced by DuckDB's file lock.** Second
  process pointed at the same data dir fails at open time.

### The graceful fallback (Gate-6 binary-matrix safety)

If `WEAVORY_STORE=duckdb` but the binary can't load — missing package,
missing prebuilt for this arch, ABI mismatch, SELinux-blocked mmap —
the factory:

1. Logs one stderr warning (structured, grep-able).
2. Opens a JSONL store instead.
3. Returns a valid `PersistentStore` to the caller.

The server keeps starting. The CI matrix (Ubuntu + macOS + Node 22)
passes either way because the three-layer defense is architectural:

```
Layer 1: @duckdb/node-api is "optionalDependencies"
         → pnpm install never fails on this package
Layer 2: persist_duckdb.ts uses dynamic `await import()`
         → missing module throws a catchable Error instead of crashing
Layer 3: openPersistentStore() catches the error in a try/catch
         → falls back to JSONL transparently
```

This pattern is the same Node uses for `fsevents` on non-macOS
platforms. Nothing new. Just applied rigorously.

---

## Policy enforcement

The pre-believe policy hook is where weavory earns its Responsible-AI
positioning most directly.

### What the policy file looks like

```json
{
  "version": "1.0.0",
  "subject_allow": ["scene:*", "patient:*"],
  "subject_deny":  ["scene:admin/*"],
  "predicate_allow": ["observation", "claim", "capability.offers"],
  "predicate_deny":  ["internal.secret", "pii.ssn", "pii.dob"],
  "max_object_bytes": 65536
}
```

### Evaluation order (short-circuit on first match)

1. `max_object_bytes` — UTF-8 byte count of JSON-stringified `object`
2. `predicate_deny` — exact match
3. `predicate_allow` — exact match (absent or empty = allow all)
4. `subject_deny` — glob (trailing `*` = prefix, else exact)
5. `subject_allow` — glob (absent or empty = allow all)

### Why this design

- **No regex.** Glob-prefix or exact match only. Policy files are meant
  to be diff-reviewable by non-engineers.
- **Deny-wins.** `subject_deny` evaluated before `subject_allow` so a
  blanket `scene:*` allow can safely coexist with a `scene:admin/*`
  deny.
- **UTF-8 byte count on size.** JavaScript's `string.length` counts
  code units, not bytes. A `.repeat(100)` of emoji would pass a
  naive cap. We use `Buffer.byteLength` so the 8192-byte cap means
  8192 actual bytes on the wire.
- **Permissive default.** Operators opt into tighter policy by adding
  entries. An empty policy doesn't block anything. This matches SOC2
  CC6.1 "least privilege when operator defines the rules" without
  breaking the hackathon demo defaults.
- **Fail-loud on misconfig.** Invalid policy JSON or schema violation
  → CLI exits code 4 with operator-actionable message. No silent
  degradation to no-policy.

---

## Edge cases handled (and one deliberately not)

### Handled

| Edge case | What happens | Tested |
|-----------|--------------|--------|
| Missing `WEAVORY_DATA_DIR` | Auto-created on first write | ✅ unit test |
| Empty JSONL files | Load returns empty arrays, no warning | ✅ unit test |
| JSONL with only a meta line | Same as empty | ✅ unit test |
| Corrupt JSON line | Skipped + warn, neighbours survive | ✅ unit test |
| Schema-invalid JSON line | Skipped + warn (version skew tolerated) | ✅ unit test |
| Truncated final line (crash mid-write) | Treated as invalid JSON → skipped | ✅ unit test |
| Duplicate belief id across lines | Last write wins (covers tombstone updates) | ✅ unit test |
| Re-opening same data dir twice in one process | Meta not double-seeded; no data duplication | ✅ unit test |
| DuckDB binary missing | Log + fallback to JSONL | ✅ unit test (capability probe) |
| DuckDB schema already exists | `CREATE IF NOT EXISTS` is idempotent | ✅ unit test |
| DuckDB process crash mid-write | WAL replay on next open | architectural |
| Two concurrent DuckDB writers | Second fails at open time via file lock | architectural + documented |
| Audit chain tampered on disk | Exit(3) on next restart with `bad_index` | ✅ integration test path |
| Rehydrate writes to persist (duplication) | Bypassed via `restoreFromRecords` | ✅ integration test |
| Attestation survives restart | `trust.jsonl` replayed, LWW on (signer, topic) | ✅ integration test |
| Policy file missing | CLI exit(4) with "cannot read file" | ✅ unit test |
| Policy JSON invalid | CLI exit(4) with "not valid JSON" | ✅ unit test |
| Policy schema version wrong | CLI exit(4) with "failed validation" | ✅ unit test |
| Policy denies a believe | PolicyDenialError; no belief or audit entry recorded | ✅ unit + smoke test |
| UTF-8 emoji in policy byte-cap | Counted as 4+ bytes, not 1 char | ✅ unit test |
| Cause id references unknown belief | Rejected at ingest with clear message | ✅ existing test |
| Client passes invalid Zod shape | MCP SDK rejects with schema error | ✅ existing test |
| Subscription queue overflow | Oldest drops, `dropped_count` increments | ✅ existing test |
| Ed25519 signature forgery attempt | Rejected by `verifyBelief` before store | ✅ existing test |
| Multiple subscriptions fan-out | Predicate-bucket index keeps it O(matching-bucket) | ✅ perf test |
| Empty query recall | Short-circuits without stringifying each belief's object | ✅ perf test |
| Adversarial mode unknown signer | Default trust 0.5 < floor 0.6 → filtered | ✅ existing test |

### Deliberately not handled

**Atomic believe + audit write across persistence backends.** If a
disk error occurs between `state.storeBelief()` writing to persist and
`state.appendAudit()` writing to persist, you end up with a belief on
disk that has no audit entry (or an audit entry with no belief).

**Why we don't fix this now:**
- Probability is extremely low in normal conditions (disk full,
  permission revoked mid-op).
- The MCP caller sees an error either way, so they know something went
  wrong.
- A true fix requires two-phase commit (write-ahead intent → apply →
  clear) or a single transactional boundary — meaningful complexity
  for very rare failure modes.
- For JSONL specifically, the ordering already limits the damage: the
  belief line is written first, so if audit fails the belief is
  recoverable. For DuckDB, its own transaction boundaries cover this
  if we batch the writes into a single `BEGIN; ...; COMMIT;` (P1 item).

**Documented risk:** R-15 in `control/RISKS.json` with status
`accepted`.

---

## Hackathon competency — honest assessment

### Track alignment

Primary: **Responsible AI** (track matches the feature set exactly).

- Signed beliefs → provenance
- Hash-chain audit → tamper evidence
- Trust gate + adversarial mode → safety posture
- Incident export + replay → forensics
- Policy hook → ingestion governance
- Persistence + restart verify → durability + tamper-on-restart
- Compliance mapping → SOC2 / ISO / GDPR / EU AI Act / NIST

Secondary: **Enterprise AI / Modernization** — the "Kafka for agent
beliefs" framing fits, but is weaker without federation; we lead with
Responsible AI.

### Scoring math (NandaHack rubric: 40 / 40 / 20)

**Impact (40 / 40) — strong.**
- Responsible AI unlocks BFSI / healthcare enterprise adoption. That is
  the single highest-value ecosystem unlock right now, per the track
  description.
- No existing MCP-native memory product ships signed beliefs + hash-
  chain audit + trust gating + incident replay in one substrate. The
  competitive landscape (Mem0, Zep, Letta, Cognee, Memorix, MACP,
  shared-memory-mcp, InALign) each cover parts; the *intersection* is
  an unowned corner.

**Technical Depth (40 / 40) — strong.**
- Crypto: Ed25519 + BLAKE3 + HKDF-SHA256, all audited noble libraries.
- Semantics: bi-temporal recall, OR-set tombstones, G-Set beliefs,
  LWW-or-consensus conflict merge.
- Persistence: two backends with graceful fallback. Three-layer binary-
  matrix defense.
- Tests: 178 passing across unit + integration + perf. 12 machine-verified
  gates with commit hashes.
- Strict TypeScript, no `any` in `src/`. Deterministic defaults;
  non-determinism is env-flagged.

**Simplicity (20 / 20) — strong.**
- Five MCP tools, locked. Public API cannot drift mid-project.
- One install: `git clone && pnpm install && pnpm build`.
- Time-to-first-belief on a fresh machine: ~90 seconds.
- Gate 7 proves a stock Claude Opus 4.7 agent can use the substrate
  with zero bespoke guidance — that is the strongest simplicity
  signal any hackathon entry can produce.

### Likely total score projection (honest)

Not guessing at a number — judges vary. But:
- We have zero fabricated claims. Everything in our docs maps to a
  real source file.
- We have a working demo for every pitch beat.
- We have machine-verifiable gates that can be reproduced live.
- We have the right track fit and the right scope boundaries.

If Responsible AI is a track judges care about, weavory is a strong
candidate. If they weight Impact on "sales pipeline expansion" or
"executive coaching," we're not the fit.

### The one competitive risk we take seriously

**Someone else ships a similar substrate before June 13.** That's R-01
in our risk register. Mitigation: publish the "belief-as-a-message"
category flag + benchmarks publicly as soon as the repo goes public.
This is a marketing / positioning move, not a code change.

---

## What weavory is NOT

Stated bluntly so operators and judges know the scope boundaries:

- **Not a vector database.** Recall uses substring match today. LanceDB
  vector search is backlog B-0001. That's fine for Gate 3; it'd be
  limiting at 1M+ beliefs per domain.
- **Not a federated system.** One process, one data dir. libp2p gossip
  is backlog B-0006.
- **Not a multi-tenant SaaS.** No tenant isolation, no billing, no
  SSO, no per-tenant quotas. Deployment is one substrate per team or
  per agent pipeline.
- **Not encrypted at rest.** Filesystem-layer encryption (LUKS, EFS/KMS)
  is the documented approach. Application-layer encryption is Phase-2.
- **Not a full CRDT.** We have G-Set + LWW tombstones + optional
  consensus merge on reads. A true state-merging CRDT with
  commutativity / associativity proofs is a multi-week research
  project — not what this is.
- **Not a production-ready enterprise SKU.** Think of it as the
  reference implementation for a category. To be shipped as a product,
  you'd add the items in P2 backlog.

Every "not" above is a deliberate scope boundary. None of them are
accidental gaps we hid under the rug.

---

## Reproducing every claim in this document

```bash
# Clone + install + build (~90 seconds on a fresh machine)
git clone https://github.com/DeepakKTS/weavory.ai.git
cd weavory.ai
pnpm install && pnpm build

# 178/178 tests (unit + integration + perf)
pnpm test

# All 12 machine-verified gates
pnpm verify:gate3                         # judge path (Gate 3)
pnpm verify:gate4                         # trust + quarantine
pnpm verify:gate5                         # bi-temporal
bash scripts/verify/gate_commons.sh       # subscription + consensus merge
bash scripts/verify/gate_wall.sh          # tamper detection
bash scripts/verify/gate_gauntlet.sh      # branch + replay
bash scripts/verify/gate_bazaar.sh        # reputation + capability + escrow
bash scripts/verify/gate_throne.sh        # four-arena integration

# Persistence end-to-end (JSONL, default)
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/w1 node dist/cli.js start
# — in another terminal, attach an MCP client, call weavory.believe, kill
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/w1 node dist/cli.js start
# — attach, call weavory.recall with min_trust=-1, see the same belief id

# Persistence with DuckDB
WEAVORY_PERSIST=1 WEAVORY_STORE=duckdb WEAVORY_DATA_DIR=/tmp/w2 node dist/cli.js start

# Policy enforcement
echo '{"version":"1.0.0","predicate_deny":["internal.secret"]}' > /tmp/policy.json
WEAVORY_POLICY_FILE=/tmp/policy.json node dist/cli.js start
# — call weavory.believe with predicate="internal.secret" → structured error

# Standalone throughput bench (writes ops/data/bench.json)
pnpm bench

# Dashboard (truthful, reads only real files)
pnpm dashboard:serve
# → http://localhost:4317/ops/weavory-dashboard.html
# → http://localhost:4317/ops/weavory.ai-overview_steps.html

# Docker build (if you have Docker)
docker compose up --build
```

Every row in `ops/data/gates.json` carries a real commit hash. Every
row in `ops/data/bench.json` is a real timing from this machine. The
audit trail is in git.

---

*Last reviewed: 2026-04-22 against HEAD of main (`6661f76`). CI green:
https://github.com/DeepakKTS/weavory.ai/actions/runs/24756460520*
