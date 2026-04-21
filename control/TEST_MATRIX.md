# weavory.ai — Test Matrix

Tests listed here are **planned** until implemented. Status cells are the truth about whether a test *exists and runs*, not whether it hypothetically would. The dashboard reads `/ops/data/tests.json` (Vitest JSON reporter) — this file describes intent; `tests.json` is the source of truth for pass/fail.

Legend:
- **Planned** — described here, not yet implemented.
- **Implemented** — test file exists and is picked up by Vitest.
- **Passing** / **Failing** — from most recent `pnpm test` run (source: `ops/data/tests.json`).

---

## Core protocol (src/core/*)

| ID | Name | Expected behaviour | Status |
|----|------|--------------------|--------|
| T-C-001 | `belief.parse` accepts NANDA-AgentFacts-shaped input | Zod validates; produces typed `Belief` | Passing |
| T-C-002 | `belief.parse` rejects missing `signer_id` | Validation error with field path | Passing |
| T-C-003 | Ed25519 round-trip: sign → verify | `verify(signed)` returns `ok: true` | Passing |
| T-C-004 | Ed25519 tamper detection | Modified payload → `verify` returns `ok: false` with typed reason | Passing |
| T-C-005 | BLAKE3 chain: each entry references prev hash | `chain.append(x)` produces entry whose `prev === last.hash` | Passing |
| T-C-006 | BLAKE3 chain tamper detection | Modifying any entry breaks the chain on `chain.verify()` | Passing |

## Storage (src/store/*)

| ID | Name | Expected behaviour | Status |
|----|------|--------------------|--------|
| T-S-001 | LanceDB persist + top-k recall | `recall(query, top_k=5)` returns 5 nearest beliefs | Planned |
| T-S-002 | DuckDB bi-temporal `as_of` | Belief invalidated at T1; `recall(..., as_of=T0)` returns original | Planned |
| T-S-003 | Append-only audit log | Entries are strictly ordered; `audit.length` monotonic | Passing |
| T-S-004 | OR-set tombstone respected by recall | `forget(id)` excludes the belief from default recall | Passing |

## Coordination (src/coord/*)

| ID | Name | Expected behaviour | Status |
|----|------|--------------------|--------|
| T-D-001 | LWW default merge | Two concurrent writes → later `recorded_at` wins | Planned |
| T-D-002 | OR-set concurrent add / remove | Add + remove from different signers converge deterministically | Planned |
| T-D-003 | Semantic subscribe delivers matching belief | SSE client receives the belief within 150 ms | Planned |
| T-D-004 | Subscribe backpressure | Slow consumer does not drop beliefs; delivery receipt tracked | Planned |

## Trust (src/trust/*)

| ID | Name | Expected behaviour | Status |
|----|------|--------------------|--------|
| T-T-001 | Unsigned belief quarantined | `recall` default does not return unsigned beliefs | Passing (covered indirectly: all beliefs are server-signed; trust-gate covers the semantic equivalent) |
| T-T-002 | Low-trust belief quarantined | Belief from signer with trust < threshold is excluded by default | Passing |
| T-T-003 | `attest` raises trust | After `attest(s, topic, +0.5)`, signer `s`'s beliefs on `topic` become visible | Passing |
| T-T-004 | Trust decay on conflict | Conflicting claim from low-trust signer does not override high-trust | Planned |

## MCP surface (src/mcp/*)

| ID | Name | Expected behaviour | Status |
|----|------|--------------------|--------|
| T-M-001 | Tool listing exposes all five tools | `listTools()` returns `[believe, recall, subscribe, attest, forget]` | Passing |
| T-M-002 | Zod schema rejects malformed `believe` args | Missing `subject` → structured error | Passing |
| T-M-003 | `subscribe` opens SSE stream | Client receives `subscription_id` + ack (SSE transport: Phase G) | Passing (for subscription_id + ack; SSE deferred) |

## Integration / judge gates

| ID | Name | Expected behaviour | Gate | Status |
|----|------|--------------------|------|--------|
| T-I-001 | Two-agent belief exchange | Agent A writes; Agent B recalls in separate session | 3 | Passing (engine-level; E2E MCP walkthrough pending Gate 3) |
| T-I-002 | Adversarial quarantine | Attacker-agent unsigned write does not leak into honest agent's recall | 4 | Planned |
| T-I-003 | `as_of` recall | Deterministic prior-state reconstruction | 5 | Passing |
| T-I-004 | Fresh-machine install | `npx @weavory/mcp start` on clean VM → Gate 3 passes | 6 | Planned |
| T-I-005 | README-only judge simulation | Generic agent completes scripted task using only `docs/README.md` | 7 | Planned |

---

## Current totals (2026-04-21, post-Gate-2)

- **Implemented + Passing:** 16 matrix entries (T-C-001..T-C-006, T-S-003, T-S-004, T-T-001..T-T-003, T-M-001..T-M-003, T-I-001 engine-level, T-I-003)
- **Implemented total tests (Vitest):** 45 / 45 passing — 17 belief + 8 sign + 8 chain + 5 engine-integration + 7 MCP-integration (see `ops/data/tests.json`)
- **Gates passed:** 1, 2 (see `ops/data/gates.json`)
- **Planned:** 9 matrix entries (remaining storage, subscribe SSE transport, trust decay, judge-gate E2E)
