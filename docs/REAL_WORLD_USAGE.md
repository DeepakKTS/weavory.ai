# weavory.ai — Real-World Usage

> **For an engineering lead deciding whether and how to drop weavory
> into an existing agent stack.** Concrete, honest, no marketing.

## The integration shape

Weavory is a **sidecar process** that sits next to your agents.
One weavory per trust boundary (one team, one pipeline, one
regulated workflow). Agents talk to it over MCP stdio — the same way
they'd call any other MCP tool.

```
┌─────────────────┐   MCP stdio    ┌──────────────────┐
│  Agent A        │ ─────────────▶ │                  │
├─────────────────┤                │                  │
│  Agent B        │ ─────────────▶ │  weavory server  │
├─────────────────┤                │   (one process)  │
│  Agent C        │ ─────────────▶ │                  │
└─────────────────┘                └──────┬───────────┘
                                          │
                                  ┌───────┴───────┐
                                  │  /data dir    │  ← persistent JSONL
                                  │  (per env)    │    or DuckDB
                                  └───────────────┘
```

Agents don't need a weavory SDK. They only need to speak MCP — which
Claude Desktop, OpenClaw, Cursor, and the official MCP SDKs all do.

---

## Primary scenario — BFSI claims triage (runnable demo)

The archetypal Responsible-AI use case. Runnable today:

```bash
pnpm exec tsx examples/bfsi_claims_triage.ts
bash scripts/verify/gate_bfsi.sh     # 5-check verifier
```

Four agents collaborate on a motor-insurance claim; a
compromised/unknown signer tries to inject a forged approval.

| Agent | Role |
|-------|------|
| `claims-intake` | Logs incident facts (amount, policy, narrative). |
| `fraud-detector` | Risk scoring; references intake via `causes[]`. |
| `underwriter` | Attests upstream signers; recalls trusted chain; publishes terms. |
| `approver` | Attests upstream; recalls trusted chain only; issues final decision. |
| `mallet` (attacker) | Unknown signer; tries to publish a fake `approval` belief. |

What weavory provides to this pipeline that a "memory" product
doesn't:

1. **Provenance.** Every belief is Ed25519-signed. The final decision's
   `audit_trail` lists specific belief ids — reviewers can walk back
   from "who approved this?" to exact signed facts.
2. **Trust gate.** Under `WEAVORY_ADVERSARIAL=1` the default recall
   trust floor is 0.6. An unknown signer sits at neutral trust 0.5
   and therefore **never reaches the approver's default recall**.
3. **Compliance audit view.** `recall({ min_trust: -1 })` surfaces
   everything — including the attempt — so forensics can see what
   was TRIED, not just what succeeded.
4. **Replay.** `exportIncident` writes a reviewable JSON file;
   `weavory replay --from <path>` rehydrates the state and re-verifies
   the audit chain off-process. Incident artifacts are the durable
   record a regulator can ask for later.

See [`examples/bfsi_claims_triage.ts`](../examples/bfsi_claims_triage.ts)
for the full flow (~260 lines, self-asserting).

---

## Other realistic scenarios (sketched, not demos)

### Healthcare — clinical decision support

Multiple LLM agents share observations about a patient. Regulations
demand attributability ("which agent produced this observation, and
with what calibration?") and revocation ("this lab result was
misread; remove it from active use but keep the record").

| Need | Feature |
|------|---------|
| Who produced this observation? | `signer_id` + Ed25519 signature |
| At what confidence? | `confidence` in `[0, 1]` |
| Revoke without erasing | `weavory.forget` — invalidates live recall, preserves audit |
| Reconstruct at time of diagnosis | `recall({ as_of: "<ISO>" })` — bi-temporal |
| Block PII predicates at ingest | `WEAVORY_POLICY_FILE` with `predicate_deny: ["pii.*"]` |

### Agent-framework security — prompt-injection defense

A compromised agent starts publishing poisoned beliefs ("the user's API
key is X"). In a plain shared-memory system, other agents
immediately see and act on it. With weavory:

- Default recall filters the compromised signer unless it has been
  attested.
- A counter-attestation (`score: -1`) poisons the signer everywhere
  at once.
- Incident export captures the attempt for replay.

This is the same architectural pattern the Wall arena and the BFSI
demo both exercise — weavory gives you a **revocable, attributable**
shared memory instead of a plain one.

### Regulated audit — "what did our stack decide last quarter?"

Compliance asks for reproducible answers on a 30-day window.

| Need | Feature |
|------|---------|
| No retroactive edits | Append-only audit chain, BLAKE3-linked |
| Walk history by time | `recall({ as_of })` |
| Export for offline review | `exportIncident` |
| Re-run queries off-process | `weavory replay` |
| SQL analytics over the log | `WEAVORY_STORE=duckdb` |

### Internal multi-agent coordination ("Client 0")

Not regulated, but still benefits from a single typed shared bus
instead of ad-hoc state. Each agent's output is a signed belief;
downstream agents can subscribe and consume with backpressure via
the bounded per-subscription queue.

---

## Day-in-the-life operations checklist

When you're ready to run weavory next to a real pipeline, decide up
front:

| Decision | Options | Default |
|----------|---------|---------|
| Persistence? | JSONL / DuckDB / none | **JSONL** — restart-safe, zero native deps |
| Data directory | any writable path | `./.weavory-data` |
| Adversarial mode | on/off | Off for dev, **on for regulated workflows** |
| Policy file | any JSON file | None (permissive); define one for regulated deploys |
| Container | `node dist/cli.js start` or `docker compose up` | Compose with persistent volume |

Minimal production env:

```bash
WEAVORY_PERSIST=1
WEAVORY_DATA_DIR=/var/lib/weavory
WEAVORY_ADVERSARIAL=1
WEAVORY_POLICY_FILE=/etc/weavory/policy.json
node dist/cli.js start
```

Or via Compose:

```yaml
services:
  weavory:
    image: weavory-ai:0.1.0
    environment:
      WEAVORY_PERSIST: "1"
      WEAVORY_DATA_DIR: /data
      WEAVORY_ADVERSARIAL: "1"
      WEAVORY_POLICY_FILE: /policy/rules.json
    volumes:
      - weavory-data:/data
      - ./policy:/policy:ro
    stdin_open: true
    tty: false
```

---

## Monitoring & day-two

- **`ops/data/runtime.json`** — refreshed per operation (debounced
  50 ms). Surfaces `beliefs_total`, `audit_length`,
  `last_event_ts`, `tamper_alarm`. Mount-or-scrape for dashboards.
- **Container healthcheck** — the shipped `Dockerfile` probes
  `runtime.json` mtime; stale snapshot ⇒ unhealthy.
- **Chain tamper alarm** — `tamper_alarm` goes non-null the moment
  `scanForTamper` detects a chain break. Page on that.
- **Startup chain verify** — under `WEAVORY_PERSIST=1`, a tampered
  data directory fails `weavory start` with **exit code 3** and a
  clear reason. Treat as a security event.
- **Incident export** — call `exportIncident(state, { reason })`
  from your own tooling (or let the Wall drill do it) to produce a
  dated, reviewable JSON artifact.

---

## What weavory is not (for this audience)

- Not a memory-as-a-service. One process per trust boundary — you
  run it, you own the data directory.
- Not an agent framework. Your agents remain your code; weavory is
  the shared bus.
- Not an identity provider. Signer identities are public keys; bind
  them to your organizational identities externally.
- Not a data lake. The persistent store holds operational state;
  long-term analytics pipelines should continue to ingest from
  their usual sources.

See [`docs/COMPLIANCE.md`](./COMPLIANCE.md) for the full control
mapping and [`control/BACKLOG.json`](../control/BACKLOG.json) for
the honest deferred list.

---

## Fast-path reading order for an integrator

1. Run `pnpm exec tsx examples/two_agents_collaborate.ts` — Gate 3, the
   judge path. 15 seconds.
2. Run `pnpm exec tsx examples/bfsi_claims_triage.ts` — this page's
   primary scenario. 3 seconds.
3. Skim [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — one page.
4. Read [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) before writing a
   compose file.
5. Draft your own policy file (see examples in
   [`src/engine/policy.ts`](../src/engine/policy.ts)).
6. Wire your agents to `node dist/cli.js start` via MCP stdio.

Total time: under an hour on a prepared laptop.
