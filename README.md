# weavory.ai

**Responsible-AI belief coordination substrate for AI agent swarms.**
MCP-native · NANDA AgentFacts-compatible · five tools, locked.

[![npm](https://img.shields.io/npm/v/@weavory/mcp.svg)](https://www.npmjs.com/package/@weavory/mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-197%2F197-brightgreen.svg)](#project-status)
[![gates](https://img.shields.io/badge/gates-12%2F12-brightgreen.svg)](#project-status)

An MCP server that lets AI agents share **signed beliefs** with
**trust-gated recall**, **BLAKE3-hash-chained audit**, **bi-temporal
replay**, and a **pre-ingest governance policy** — in five tools, one
process, zero fabricated claims.

Built for [NandaHack 2026](https://projectnanda.org) (HCLTech × MIT
Media Lab). Pitched in the **Responsible AI** track.

---

## Install

```bash
# Fastest — MCP via npx (no clone, no build)
npx -y @weavory/mcp start

# Container — multi-arch (linux/amd64, linux/arm64)
docker run -v weavory-data:/data ghcr.io/deepakkts/weavory:latest

# From source — canonical Gate-7 judge path
git clone https://github.com/DeepakKTS/weavory.ai.git
cd weavory.ai && pnpm install && pnpm build
```

All three work today. `docs/README.md` (the judge runbook) exercises
the last path.

---

## The five tools (locked — ADR-005)

| Tool | Purpose |
|------|---------|
| `weavory.believe` | Sign, store, audit-append, and fan out a new belief. |
| `weavory.recall` | Trust-gated retrieval with bi-temporal `as_of`, quarantine filter, subject/predicate/min_confidence filters. |
| `weavory.subscribe` | Register a bounded queue keyed on a pattern + filters. |
| `weavory.attest` | Update `trust(signer, topic)` in `[-1, 1]`. |
| `weavory.forget` | OR-set tombstone — `invalidated_at` is set; audit history preserved for `as_of` replay. |

Anything that looks like a new tool is out of scope per
[`control/DECISIONS.md`](./control/DECISIONS.md).

---

## 60-second flavor

Four agents triage a motor-insurance claim; a compromised signer
tries to inject a forged approval. Weavory's trust gate quarantines
the forgery; the honest chain completes; an incident JSON is exported
for forensic review.

```bash
pnpm exec tsx examples/bfsi_claims_triage.ts
bash scripts/verify/gate_bfsi.sh    # 5-check verifier
```

The demo self-asserts: attacker belief is **never visible** in the
approver's default recall, but **is visible** in the compliance audit
view (`min_trust: -1`). Audit chain verifies `ok` at the end. See
[`docs/REAL_WORLD_USAGE.md`](./docs/REAL_WORLD_USAGE.md) for the full
scenario.

---

## What it does

- **Ed25519-signed beliefs** with BLAKE3-hash-chained audit log —
  tamper-evident by construction.
- **Trust-gated recall** — default floor 0.3, 0.6 under
  `WEAVORY_ADVERSARIAL=1`. Unknown signers quarantined by default.
- **Bi-temporal replay** — `recall({ as_of: "<ISO>" })` reconstructs
  state at any past instant. `forget` preserves history.
- **Dual persistence** — JSONL (default, zero native deps,
  synchronously durable) or DuckDB (opt-in via
  `WEAVORY_STORE=duckdb`, WAL-backed) with graceful binary fallback.
- **Pre-believe policy hook** — `WEAVORY_POLICY_FILE=<json>` for
  allow/deny rules on subjects (glob), predicates (exact), payload
  size.
- **Incident export + replay** — `exportIncident()` dumps state to
  JSON; `weavory replay --from <path>` rehydrates off-process for
  forensic review.
- **CRDT-adjacent primitives** — G-Set for beliefs, LWW tombstones,
  optional consensus merge on recall. (Not a full state-merging
  CRDT; we don't overclaim — see
  [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).)

---

## Documentation

| Doc | Audience |
|-----|---------|
| [`docs/README.md`](./docs/README.md) | Canonical 60-second judge runbook |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | One-page system mental model |
| [`docs/REAL_WORLD_USAGE.md`](./docs/REAL_WORLD_USAGE.md) | Enterprise integration patterns + BFSI scenario |
| [`docs/INSTALL.md`](./docs/INSTALL.md) | Three install paths, Claude Desktop config |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | Env-var reference, persistence modes, Compose |
| [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) | Operational scenarios (restart, policy denial, incident replay, key rotation) |
| [`docs/COMPLIANCE.md`](./docs/COMPLIANCE.md) | SOC2 / ISO27001 / GDPR / EU AI Act / NIST AI-RMF control mapping |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Protected · mitigated · deferred controls (honest) |
| [`docs/HACKATHON_PITCH.md`](./docs/HACKATHON_PITCH.md) | 3-minute pitch script, judge-question playbook |
| [`docs/SHIP_READINESS.md`](./docs/SHIP_READINESS.md) | Current-state honest snapshot |

---

## Project status

All real, all reproducible:

- **197/197 Vitest** tests — unit + integration + perf
- **12/12 gate scripts** — 7 Phase-1 + 5 Phase-G arenas (Commons,
  Wall, Gauntlet, Bazaar, Throne) + Gate BFSI. Recorded with commit
  hashes in [`ops/data/gates.json`](./ops/data/gates.json).
- **CI green** on Ubuntu + macOS (Node 22 LTS) + **Gate 7**
  stock-Claude-Opus judge simulation on every push to `main`.
- **Strict TypeScript** — no `any` in `src/`.
- **Time-to-first-belief** from fresh `npx -y @weavory/mcp start`:
  under 30 seconds.

Live dashboard (when running locally):
`pnpm dashboard:serve` → <http://localhost:4317/ops/weavory-dashboard.html>

The dashboard reads only real files under `control/` + `ops/data/`.
Missing data shows "Not collected yet" — never fabricated.

---

## What it is NOT (deliberate scope boundaries)

- Not a generic memory-as-a-service — run one weavory per trust boundary.
- Not a vector database — substring recall today (LanceDB is backlog).
- Not federated — single writer per data directory.
- Not multi-tenant — tenant isolation is filesystem / process level.
- Not encrypted at rest — use filesystem-layer encryption (LUKS, EFS/KMS).
- Not an identity provider — signer IDs are public keys; SSO/OIDC mapping is external.
- Not a full state-merging CRDT — see the primitives we do have in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

Every "not" is in [`control/BACKLOG.json`](./control/BACKLOG.json)
with an ID and deferral rationale.

---

## Context

Entry for **NandaHack 2026** (HCLTech × MIT Media Lab, Apr 10 – Jun
13, 2026). Phase-1 submission artifact.

Primary track: **Responsible AI** — every built feature maps to a
governance / safety / audit primitive named in the track description.
Full alignment in [`docs/HACKATHON_PITCH.md`](./docs/HACKATHON_PITCH.md).

---

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
