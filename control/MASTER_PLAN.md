# weavory.ai — Master Plan (condensed)

> Canonical long-form plan lives at `/Users/deepakzedler/.claude/plans/nandahack-agentic-ai-hackathon-synthetic-cake.md`. This file is the condensed in-repo mirror, kept in sync.

## Mission

Build **weavory.ai** — an MCP-native **shared belief coordination layer** for AI agents — for NandaHack 2026 (HCLTech × MIT Media Lab, Apr 10 – Jun 13, 2026). Win condition is the Phase-1 judge test on May 7: a stock OpenClaw-compatible agent must use weavory with only the README on a fresh machine.

## Non-negotiable public API (exactly five MCP tools)

1. `weavory_believe(subject, predicate, object, confidence?, valid_from?, valid_to?, causes?)`
2. `weavory_recall(query, top_k?, as_of?, min_trust?, filters?)`
3. `weavory_subscribe(pattern, filters?)` → SSE stream
4. `weavory_attest(signer_id, topic, score)`
5. `weavory_forget(belief_id, reason?)` → OR-set tombstone

## Differentiator

The unowned 2026 corner: **MCP-native + semantic subscribe + bi-temporal (valid-time × transaction-time) + trust-propagated reads + CRDT semantic merge** in one runtime substrate. No existing memory framework covers all five.

## Phases & gates

| Phase | Work | Exit gate |
|-------|------|-----------|
| A | Bootstrap: repo, control files, dashboard shell, collectors | **Gate 1** ✅ |
| B | Core protocol: belief schema, Ed25519, temporal, trust, BLAKE3 chain | schema tests green ✅ |
| C | MCP tools wired (all five) | **Gate 2** ✅ |
| D | Runnable two-agent demo + judge walkthrough | **Gate 3** ✅ |
| E | Truthful dashboard wired to real data sources | **Gate 4** ✅ |
| F | Hardening: tests, `as_of`, fresh-machine CI | **Gates 5, 6, 7** ✅ |
| **G** | **Arena extensions (composed on top of Phase-1 core)** | **Gate Commons + Wall + Gauntlet + Bazaar + Throne** ✅ |

### Phase G sub-phases (all complete)

| Sub | Deliverable | Arena gate |
|-----|-------------|------------|
| G.1 | Live runtime collection → `ops/data/runtime.json` atomic writer | (infra) |
| G.2 | Subscribe match queue + opt-in consensus/LWW merge + conflict visibility | **Gate Commons** ✅ |
| G.3 | Adversarial mode + tamper alarm + incident export | **Gate Wall** ✅ |
| G.4 | `cloneState` branches + `weavory replay` CLI + incident rehydrate | **Gate Gauntlet** ✅ |
| G.5 | Reputation aggregate + capability ads + causal-chain escrow | **Gate Bazaar** ✅ |
| G.6 | One EngineState drives all four arenas at once | **Gate Throne** ✅ |

## Stack

TypeScript (Node 20+) · `@modelcontextprotocol/sdk` · Zod · LanceDB · DuckDB · `@noble/ed25519` + `@noble/hashes` (BLAKE3) · Hono + SSE · Next.js dashboard · Vitest + c8 · `npx @weavory/mcp`.

## Strict execution rules

1. No overbuilding.
2. No completion claims without implementation + tests + demo wiring.
3. No fabricated dashboard status.
4. Every status must come from a machine-readable source; show "Not collected yet" when absent.
5. Phase-1 success > Phase-2 breadth.
6. Small, task-id-mapped commits.
