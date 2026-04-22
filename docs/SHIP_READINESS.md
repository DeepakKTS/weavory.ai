# weavory.ai — Ship Readiness

**Status:** shippable for the NandaHack 2026 Responsible-AI track.
**Last updated:** 2026-04-22 against `main` (post Phase-I P0-9).

This page is the **honest current-state snapshot**. Everything in green
is real, reproducible, and tested. Everything yellow is deliberately
scoped to post-hackathon.

---

## What ships today ✅

### Core runtime

- **Five-tool MCP surface** — `believe`, `recall`, `subscribe`, `attest`,
  `forget`. Locked by ADR-005, enforced by `scripts/verify/gate2.sh`.
- **Ed25519-signed beliefs** with content-addressed BLAKE3 ids.
- **BLAKE3 hash-chained audit log** with genesis sentinel and online
  verification.
- **Trust-gated recall** with per-(signer × topic) vectors, default floor
  0.3 (0.6 under `WEAVORY_ADVERSARIAL=1`).
- **Bi-temporal recall** via `as_of` — reconstructs state as of an ISO
  timestamp.
- **OR-set-style tombstones** via `forget` — preserves audit, invalidates
  the belief for live recall.
- **Subscription match queue** with bounded size + drain-via-recall.
- **Consensus merge** (optional) + conflict surfacing via
  `include_conflicts`.
- **Deterministic key derivation** from `signer_seed` via HKDF-SHA256.

### Persistence (Phase I)

- **JSONL adapter** (default) — pure Node, synchronously durable,
  corruption-tolerant parser. Zero native deps.
- **DuckDB adapter** (opt-in via `WEAVORY_STORE=duckdb`) — WAL-backed,
  optional native binding.
- **Graceful binary fallback** — if DuckDB can't load for any reason,
  system logs one warning and continues on JSONL. Three-layer defense:
  `optionalDependencies` + dynamic `import()` + factory try/catch.
- **Restart recovery** — `weavory start` rehydrates beliefs + audit +
  trust, re-verifies the audit chain, exits code 3 on breakage.

### Governance / Responsible AI (Phase I)

- **Pre-believe policy hook** — JSON-driven allow/deny for subject
  globs + predicate exacts + `max_object_bytes`. Evaluated before any
  crypto. Structured denial errors.
- **Adversarial mode** — single env var raises default trust floor.
- **Tamper detection** — runtime scan + `ops/data/runtime.json.tamper_alarm`.
- **Incident export + replay** — `weavory replay --from <incident>`
  reproduces past state for forensic review.

### Packaging & deployment (Phase I)

- **Dockerfile** (multi-stage, non-root uid 10001, tini PID 1).
- **docker-compose.yml** reference with persistent volume + env
  defaults.
- **`.dockerignore`** scoped to runtime essentials.
- **Compliance doc** mapping features to SOC2, ISO27001, GDPR, EU AI
  Act, NIST AI-RMF — with source-file pointers.
- **Install, Deployment, Runbook docs** covering every supported path.

### Quality signals

| Signal | Value |
|--------|-------|
| Vitest tests (all green) | **178/178** (up from 127 pre-Phase-I) |
| Gate scripts green | **12/12** (1–7 + commons/wall/gauntlet/bazaar/throne) |
| TypeScript strict mode | ✅ no `any` in `src/` |
| CI on Ubuntu + macOS | ✅ Node 22 matrix |
| Time-to-first-belief | ~90s on fresh machine |
| Public API surface | 5 tools (locked) |

---

## What's deliberately out of scope 🟨

Tracked honestly in `control/BACKLOG.json`:

| Item | Id | Reason |
|------|----|--------|
| Full CRDT state-merging (beyond G-Set + LWW tombstone + optional consensus) | B-0005 | Present primitives sufficient for Phase-1 arenas; full CRDT requires federation. |
| libp2p multi-node federation | B-0006 | Adds operational complexity; single-node substrate is enough for the track. |
| LanceDB vector search | B-0001 | Requires embedding model; substring recall sufficient for Gate 3. |
| HTTP transport (alongside stdio) | B-0007 | stdio covers judge + Claude Desktop; HTTP is a client SDK concern. |
| SSO / OIDC identity federation | B-0008 | Out of hackathon scope; Ed25519 identity is honestly attributable without it. |
| TLS / mTLS | — | stdio only by design. |
| Encryption at rest | — | Filesystem-layer solution (LUKS/KMS) is the documented approach. |
| Multi-tenant isolation | B-0008 | One process, one data dir. |
| Kubernetes helm chart | — | Docker compose only. |
| OpenTelemetry full wiring | B-0009 | Local runtime.json snapshot covers Gate 1-7 needs. |
| Client SDKs (LangGraph, CrewAI) | B-0007 | MCP makes them optional. |
| Policy hot-reload | — | Restart-based for safety. |
| JSONL compaction CLI | — | Manual procedure documented in RUNBOOK.md. |

---

## Known risks 🟥

| Risk | Mitigation today |
|------|------------------|
| DuckDB native binary fails on a target arch | Fallback to JSONL is automatic + tested. 3-layer defense. |
| Process crash mid-DuckDB-write (SIGKILL) | WAL replay on next open; last ~ms of writes may be lost. JSONL has no such risk. |
| Concurrent writers on same data dir | DuckDB enforces via file lock (second process errors at open). JSONL does not enforce — documented single-writer invariant. |
| Policy misconfiguration | Invalid policy exits code 4 at startup (not silent). |
| Audit chain tampering on disk | Detected on next restart — exits code 3 with bad_index reported. |

---

## Verification reproduction

Everything above is reproducible on a clean clone:

```bash
# Install + sanity check (90s on a fresh laptop)
git clone https://github.com/DeepakKTS/weavory.ai.git
cd weavory.ai
pnpm install && pnpm build

# All 12 gates + full test suite
pnpm test                               # 178/178
pnpm verify:gate3                       # two-agent exchange
pnpm verify:gate4                       # trust / quarantine
pnpm verify:gate5                       # bi-temporal recall
bash scripts/verify/gate_commons.sh     # subscription queue + merge
bash scripts/verify/gate_wall.sh        # tamper detection + incident
bash scripts/verify/gate_gauntlet.sh    # replay + branch
bash scripts/verify/gate_bazaar.sh      # reputation + capability + escrow
bash scripts/verify/gate_throne.sh      # four-arena integration

# Persistence end-to-end
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/w node dist/cli.js start   # session 1
# (believe something via MCP client, then kill)
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/w node dist/cli.js start   # session 2 recalls same belief

# DuckDB backend
WEAVORY_PERSIST=1 WEAVORY_STORE=duckdb WEAVORY_DATA_DIR=/tmp/w2 node dist/cli.js start

# Policy gate
WEAVORY_POLICY_FILE=/path/to/policy.json node dist/cli.js start

# Container
docker compose up --build
```

Every result is recorded with its commit hash in `ops/data/gates.json`.

---

## Phase I commit trail

| Commit | Scope |
|--------|-------|
| `246b0a3` | P0-1+2: README persistence-claim fix + package.json broken-refs cleanup |
| `6b6c277` | P0-3.a: PersistentStore interface + JSONL adapter + 17 unit tests |
| `1ae6ef0` | P0-3.b: EngineState + CLI wire-up, restart rehydrate + chain verify |
| `16d20ae` | P0-3.5: DuckDB adapter + graceful fallback to JSONL (9 new tests) |
| `2c4ed8e` | P0-4: pre-believe policy hook (22 new tests) |
| `e1d048e` | P0-5..P0-8: COMPLIANCE + INSTALL + DEPLOYMENT + RUNBOOK + PITCH + Dockerfile + compose |
| *(this commit)* | P0-9: SHIP_READINESS + control file updates |

---

## Where to look next

- **Judges / reviewers**: `docs/README.md` (runbook) → `docs/HACKATHON_PITCH.md` (3-min script) → run `pnpm verify:gate3`.
- **Operators**: `docs/INSTALL.md` → `docs/DEPLOYMENT.md` → `docs/RUNBOOK.md`.
- **Security / compliance**: `docs/COMPLIANCE.md` → `src/store/audit.ts` + `src/core/chain.ts` + `src/engine/policy.ts`.
- **Architects**: `control/MASTER_PLAN.md` + `control/DECISIONS.md` for ADRs, `ops/weavory.ai-overview_steps.html` for the visual walkthrough.
