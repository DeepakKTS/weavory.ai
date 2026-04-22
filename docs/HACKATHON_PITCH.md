# weavory.ai — NandaHack 2026 Pitch

**Track:** **Responsible AI** (primary) · Enterprise AI / Modernization (secondary)
**Team:** DeepakKTS
**One line:** *"Kafka for agent beliefs — the first MCP-native coordination substrate with verifiable provenance, trust-gated recall, and tamper-evident audit."*

---

## The 3-minute script

### (0:00 – 0:30) · Problem

> Enterprises in BFSI, healthcare, and government can't adopt AI agents
> because there's no memory layer that gives them verifiable provenance,
> tamper-evident audit, and governance on agent claims. Mem0, Zep, Letta,
> Cognee — all cover *memory*. None cover *trust*. The Responsible-AI track
> exists because of this gap.

### (0:30 – 1:00) · What weavory is

> Five-tool MCP server. Every belief an agent writes is Ed25519-signed,
> BLAKE3 hash-chained, and filtered through a trust gate before any other
> agent can recall it. Unsigned or low-trust claims are quarantined by
> default. On-chain-break, an alarm fires and the state is exported for
> replay. All five tools: `believe`, `recall`, `subscribe`, `attest`, `forget`.
> Public API locked by ADR-005 — no surprise surface.

### (1:00 – 2:30) · Live demo

Three scripted beats, each ≈30 seconds, each shows real output:

**Beat 1 — Gate 7 (stock agent, README only).** An unmodified Claude Opus
4.7 agent reads `docs/README.md` only, solves the two-agent belief
exchange task. 27-second proof that a third-party agent can use the
substrate with zero bespoke guidance.

```
pnpm verify:gate7
```

**Beat 2 — Wall adversarial drill.** An attacker directly tampers the audit
log. Alarm fires. Incident JSON is exported. `weavory replay` rehydrates
the captured state and shows the same tamper detection on the rehydrated
chain.

```
pnpm exec tsx examples/wall_incident.ts
node dist/cli.js replay --from ops/data/incidents/<latest>.json --query ""
```

**Beat 3 — Persistence across restart.** One session writes a belief
with `WEAVORY_PERSIST=1`. Process dies. Fresh process rehydrates from the
JSONL log, chain verifies, recall returns the same belief id.
(Optional: flip to DuckDB backend with one env var — same result, WAL-backed.)

```
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/w node dist/cli.js start
# [believe something] then kill
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/w node dist/cli.js start
# [recall finds the same belief]
```

**Bonus beat — BFSI claims-triage drill (regulated-workflow scenario).**
A four-agent motor-insurance claim pipeline (intake → fraud →
underwriting → approver) processes a $42 000 claim under
`WEAVORY_ADVERSARIAL=1`. A compromised/unknown signer attempts to inject
a forged `approval` belief. Weavory's trust gate quarantines it. The
approver finalizes the decision from the trusted chain only, with a
provable `audit_trail` in the final belief. A compliance view
(`min_trust=-1`) surfaces the forgery attempt for forensics, and an
incident file is exported so the team can replay the drill off-process.

```
pnpm exec tsx examples/bfsi_claims_triage.ts
bash scripts/verify/gate_bfsi.sh        # 5-check verifier
```

This is the memorable scenario for BFSI / healthcare / regulated-industry
judges — every Responsible-AI primitive on the roster (signed beliefs,
causal chain, quarantine, compliance audit view, incident replay) visible
in one 60-second narrative.

### (2:30 – 3:00) · Honest scope + ask

> **What ships today:** signed beliefs, hash-chain audit, trust gating,
> adversarial mode, incident export, bi-temporal recall, JSONL or DuckDB
> persistence, policy allow/deny, 178 passing tests, 12 machine-verified
> gates.
>
> **Post-hackathon:** TLS/mTLS transport, SSO/OIDC identity federation,
> libp2p multi-node gossip, Kubernetes helm. All tracked in
> `control/BACKLOG.json` with honest status — we deliberately scoped
> Phase-1 to what we could deliver well.
>
> Compliance mapping: see `docs/COMPLIANCE.md` — SOC2 CC6.1/CC7.2/CC8.1,
> ISO27001 A.12/A.18, GDPR Arts. 5/17, EU AI Act Art. 12, NIST AI-RMF.

---

## Why we fit Responsible AI (vs. other tracks)

| Track | Fit | Reason |
|-------|-----|--------|
| **Responsible AI** | **PRIMARY** | Every built feature is a direct Responsible-AI primitive: provenance (Ed25519), tamper-evidence (BLAKE3), quarantine, incident replay, policy gate, adversarial mode. |
| Enterprise AI / Modernization | Secondary | The "Kafka for agent beliefs" framing fits multi-agent enterprise pipelines, but the durable story is weaker without federation. |
| Client 0 | Supporting | Weavory can be Client 0's coordination bus, but the pitch lands stronger on Responsible AI. |
| Sales AI Enablement | Not fit | Not a memory/trust problem. |
| Executive AI Coaching | Not fit | Not infrastructure. |

---

## Judge-question playbook

Likely questions and short, honest answers:

| Q | A |
|---|---|
| "Is it really CRDT?" | CRDT-adjacent, not a full state-merging CRDT. Uses G-Set semantics for beliefs + LWW tombstones + optional consensus merge on recall. Documented in `control/DECISIONS.md`. We don't overclaim. |
| "What about persistence?" | Two modes. Default JSONL (pure Node, synchronously durable). DuckDB opt-in via env (WAL-backed). Restart-safe both ways. Demo covers it. |
| "Multi-tenant?" | Out of scope for Phase 1. One process, one data dir. Backlog B-0008. |
| "LanceDB?" | Backlog. Not claimed in README. Current recall is substring-match — good enough for Gate 3, honestly labeled. |
| "BFSI / healthcare?" | Compliance mapping (`docs/COMPLIANCE.md`) covers SOC2 / ISO / GDPR. Filesystem-layer encryption is the documented approach for at-rest. |
| "How do you know the agent is who it says?" | Ed25519 seeds map to stable signer_ids. External identity federation is Phase-2. But in-substrate, every claim is attributable. |
| "What if the binary doesn't load?" | Gate 6 (fresh-machine CI) passes both with and without DuckDB. JSONL has zero native deps. DuckDB gracefully falls back to JSONL on any failure mode. |
| "Can judges install it in 90 seconds?" | Yes: `git clone && pnpm install && pnpm build && pnpm exec tsx examples/two_agents_collaborate.ts`. CI measures this on every push. |

---

## Scoring math (the hackathon's 40/40/20)

### Impact (40%)

- Responsible AI is the explicit track for BFSI / healthcare enterprise
  adoption — the single highest-value unlock in the agents ecosystem.
- Weavory is the only working MCP-native substrate that combines signed
  beliefs + hash-chain audit + trust gating + incident replay in one
  runtime.

### Technical Depth (40%)

- Ed25519 + BLAKE3 + HKDF-SHA256 + bi-temporal recall + OR-set tombstone
  semantics + G-Set CRDT-adjacent primitives + pluggable persistence
  (JSONL + DuckDB) + env-gated policy hook + graceful native-fallback.
- 178 tests (unit + integration + perf) + 12 machine-verified gates
  recorded in `ops/data/gates.json` with commit hashes — a real audit
  trail.
- Strict TypeScript, no `any` in src/. Deterministic by default;
  every non-determinism feature-flagged.

### Simplicity (20%)

- Exactly five MCP tools. Public API is locked.
- One install command. `docs/README.md` is the judge runbook.
- Stock Claude Opus agent passes Gate 7 with zero bespoke guidance.
- Time-to-first-belief on a fresh VM: ~90 seconds (measured on every
  CI push to main).

---

## What we don't pretend to be

- Not a generic memory product. (Mem0 / Zep cover that.)
- Not a vector database. (Recall is substring today; LanceDB is backlog.)
- Not a multi-node system. (libp2p is backlog.)
- Not a complete enterprise SKU. (SSO / RBAC / TLS are backlog.)
- Not a CRDT-complete implementation. (Primitives in place; full state-
  merging CRDT is backlog.)

Every "not" is a scope boundary we picked deliberately, not a gap we hid.

---

*Pitch prepared for NandaHack 2026, MIT Media Lab × HCLTech, April 10 – June 13.*
