# weavory.ai

**Shared belief coordination substrate for AI agent swarms.**
MCP-native. NANDA AgentFacts-compatible. Five tools. No more.

> **Status:** pre-release. Phase A bootstrap complete. Phase B (core protocol) in progress. Nothing below is production-ready yet. See [`control/STATUS.json`](control/STATUS.json) for live state.

weavory is an **MCP server** that turns shared memory into a communication medium: agents publish *signed beliefs*, subscribe to *semantic patterns*, and read the world as a *bi-temporal trust-weighted graph*, with quarantine and CRDT-based semantic merge built in.

## Public API (five tools, locked)

1. `weavory.believe(subject, predicate, object, confidence?, valid_from?, valid_to?, causes?)`
2. `weavory.recall(query, top_k?, as_of?, min_trust?, filters?)`
3. `weavory.subscribe(pattern, filters?)` — SSE stream
4. `weavory.attest(signer_id, topic, score)`
5. `weavory.forget(belief_id, reason?)` — OR-set tombstone

Anything else that looks like a new tool is out-of-scope per `control/DECISIONS.md` (ADR-005).

## Quick links

- **Master plan:** [`control/MASTER_PLAN.md`](control/MASTER_PLAN.md)
- **Architectural decisions:** [`control/DECISIONS.md`](control/DECISIONS.md)
- **Judge gates:** [`control/JUDGE_GATES.md`](control/JUDGE_GATES.md)
- **Test matrix:** [`control/TEST_MATRIX.md`](control/TEST_MATRIX.md)
- **Live dashboard (local):** `pnpm dashboard:serve` → http://localhost:4317/ops/weavory-dashboard.html

The dashboard reads only real files under `control/` + `ops/data/`. Missing data shows "Not collected yet" — never fabricated.

## Install (dev)

```bash
pnpm install
pnpm verify:gate1
```

The final judge runbook — three-line install + 60-second OpenClaw walkthrough — will live at `docs/README.md` once Phase D ships. Until then, this root README is the short-form pointer.

## Context

Entry for **NandaHack 2026** (HCLTech × MIT Media Lab, Apr 10 – Jun 13, 2026). Phase-1 judge test on May 7: a stock OpenClaw-compatible agent must complete a scripted task using only `docs/README.md` on a fresh machine.

## License

MIT. See [`LICENSE`](LICENSE).
