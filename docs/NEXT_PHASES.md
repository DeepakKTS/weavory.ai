# weavory.ai — Next Phases

Phase I (ship readiness) is **done and on origin/main** as of `6661f76`.
CI on Ubuntu + macOS + Gate 7 judge simulation are all green. Below is
the honest plan for what comes next, what's inside Phase 2 of the
NandaHack itself (vs. our internal phases), and what we will NOT do.

---

## Phase alignment — NandaHack phases vs. our internal phases

> The phase terminology can get confusing. Two separate timelines overlap:

| NandaHack phase | Our internal phase | Status |
|-----------------|--------------------|--------|
| **NandaHack Phase 1** — Infrastructure Agents (Apr 10 – May 7) | Our Phases A–F (Gates 1–7) | ✅ **COMPLETE** on `53e73b1` |
| **NandaHack Phase 2** — Six Arenas (May 7 – Jun 13) | Our Phase G (Commons, Wall, Gauntlet, Bazaar, Throne) | ✅ **COMPLETE** on `43d23a7` |
| (Beyond both) — operator polish | Phase H (overview HTML) + Phase I (ship readiness) | ✅ **COMPLETE** on `6661f76` |

**So yes — we've already shipped everything the hackathon judging scheme
asks for.** Arena Phase 2 work (the five arenas — Commons, Wall,
Gauntlet, Bazaar, Throne) was done incrementally during our Phase G and
is green in `ops/data/gates.json`. We skipped only "The Forge" because
the NandaHack scope summary confirmed it was optional.

What remains is **P1** (optional improvements that strengthen the story
but aren't track-blockers) and **P2** (post-hackathon work we won't do
before demo day).

---

## P1 — Optional strengthening (only if time permits)

Each is scoped small enough to ship in a single afternoon and none is
a must-have.

### P1-1 · Automated "restart with persistence" integration test

**Why:** We have live subprocess smoke tests (ran manually in Phase I
commits), but no persisted Vitest that spawns a real child process and
asserts the round-trip. One good failure case: "believe with
`WEAVORY_PERSIST=1` → SIGKILL → restart → audit chain still verifies
and belief still recallable."

**Scope:** `tests/integration/persistence_subprocess.test.ts` — ~80
lines. Uses `node:child_process.spawn` + the MCP client SDK. Two
fixtures: JSONL + DuckDB. CI cost: adds ~3s to test time.

**Risk to ship:** low. Same test shape the existing subprocess smoke
tests already use, just formalized.

### P1-2 · BFSI claims-triage demo + `gate_bfsi.sh`

**Why:** Responsible-AI judges remember concrete scenarios. "Insurance
claims triage with adversarial drill" is exactly the BFSI story we
pitch; right now we don't have the demo to run live.

**Scope:** `examples/bfsi_claims_triage.ts` (~200 lines) — three agents
(claims intake, fraud detector, approver) publish beliefs about one
claim; a `WEAVORY_ADVERSARIAL=1` attack attempts to inject a forged
"approved" claim; the trust gate quarantines it; incident export
captures the drill. `scripts/verify/gate_bfsi.sh` grep-validates the
demo output and records a 13th entry in `ops/data/gates.json`.

**Risk to ship:** low. Reuses existing Wall adversarial primitives.

### P1-3 · `docs/ARCHITECTURE.md` + `docs/REAL_WORLD_USAGE.md`

**Why:** COMPLIANCE.md covers controls, not flow. ARCHITECTURE.md would
be the one-page mental model for a technical judge; REAL_WORLD_USAGE.md
tells a BFSI/healthcare ops lead how their team would actually use
weavory day-to-day.

**Scope:** Pull the relevant diagrams from
`ops/weavory.ai-overview_steps.html` into standalone Markdown docs.
No new content to invent — just repackaging. ~200 lines each.

**Risk to ship:** zero. Docs-only.

### P1-4 · Env-gated rate limit per `signer_id`

**Why:** Belt-and-suspenders safety. Current substrate accepts
unlimited beliefs from any signer — a runaway agent could flood the
audit chain before an operator notices.

**Scope:** `src/engine/rate_limit.ts` — token-bucket per `signer_id`,
configurable via `WEAVORY_RATE_LIMIT_PER_SEC` (default: unset =
disabled). Rejects with `RateLimitError` when exceeded. ~100 lines
+ tests.

**Risk to ship:** medium. Touches `ops.believe` hot path; needs careful
testing.

### P1-5 · `weavory health` subcommand

**Why:** Kubernetes / Docker / systemd operators want a one-line
liveness probe. The healthcheck in our Dockerfile currently checks
runtime.json mtime; a native `weavory health` would do better.

**Scope:** `node dist/cli.js health [--data-dir ...]` — reads the
runtime.json if present; if persistence is enabled, opens the store
read-only and verifies the chain; prints JSON and returns exit 0 / 1 /
2 / 3 depending on state. ~80 lines + a couple of tests.

**Risk to ship:** low.

**Recommendation:** pick two of P1-1, P1-2, P1-3. They're the
highest-leverage per hour and lowest risk. P1-4 and P1-5 are nice but
not judge-winning.

---

## P2 — Post-hackathon backlog (explicit non-goals)

These are **not** hidden gaps — they're tracked in
`control/BACKLOG.json` with real IDs, and the pitch script names them
honestly as "Phase 2+ scope."

| ID | Item | Why deferred |
|----|------|--------------|
| B-0001 | LanceDB vector search | Requires embedding model (~30 MB download or external API). Current substring recall is sufficient for Gate 3 and every arena demo. Adds real value only when we have 10K+ beliefs per domain. |
| B-0002 | ~DuckDB bi-temporal SQL~ | **Reclassified: partially shipped in P0-3.5.** DuckDB is now an available backend for the store; the bi-temporal SQL surface remains backlog because our existing `as_of` logic over the Map-backed view already satisfies Gate 5. Full SQL-level bi-temporal queries (for analytics) is Phase 2 of this item. |
| B-0005 | Full state-merging CRDT | Current G-Set + LWW + consensus covers every Phase-1 and arena scenario. Full CRDT (RCA, Δ-state, commutativity proofs) is a multi-week research item, not a hackathon task. |
| B-0006 | libp2p multi-node federation | Single-process is enough for the coordination-substrate pitch; federation is complexity multiplier that would destabilize the demo. |
| B-0007 | HTTP transport + language SDKs | stdio + MCP covers Claude Desktop, OpenClaw, Cursor. HTTP/WebSocket transports and per-language client SDKs are Phase 2+. |
| B-0008 | Multi-tenant / SSO / OIDC | Enterprise SKU work — not a research substrate concern. |
| B-0009 | OpenTelemetry + Prometheus | Local runtime.json snapshots and the dashboard are enough for Phase 1. Real OTel wiring is a Phase-2 operator concern. |

None of these block the Responsible-AI pitch. Several would be
blockers for an enterprise GA release, which weavory is not claiming
to be.

---

## What we are **not** doing before demo day

- **Not rewriting anything in a lower-level language.** TypeScript is
  the right stack for the judge story.
- **Not adding "just one more MCP tool."** Five is locked. See ADR-005.
- **Not deploying to a public hosted endpoint.** weavory is meant to
  run next to the agent process, not as SaaS.
- **Not chasing benchmarks beyond the existing `pnpm bench`.** The
  numbers we have (believe 2001 ops/sec, recall 22508 ops/sec) are
  honest, reproducible, and enough.
- **Not re-doing the overview HTML.** `ops/weavory.ai-overview_steps.html`
  is the single visual artifact for the demo.
- **Not re-scoping the five tools.** Adding sixth/seventh tools ("policy",
  "health", "metrics") would weaken the Gate-2 story. Everything we
  need goes through the existing tools or an env-gated server-side
  behavior.

---

## Commit discipline for P1 (if we do it)

Same rules as Phase I:
- Additive only; feature-flagged where code is touched
- Every commit: `pnpm lint` + `pnpm test` + at least one gate script green
- No Phase-1 or arena gate regressions
- One commit per P1 item; small, reviewable, revertable

---

*Plan written 2026-04-22. Next review: after the first judge-rehearsal
on a fresh VM.*
