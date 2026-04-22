# control/ — internal development tracking

This directory holds the project's **internal engineering journal**.
It is not user documentation, not a stable API, and not part of the
published npm package or Docker image.

User-facing documentation lives in [`../docs/`](../docs/).

## Contents

| File | Purpose |
|------|---------|
| `MASTER_PLAN.md` | Frozen high-level plan from project bootstrap. Historical reference. |
| `DECISIONS.md` | Architecture Decision Records (ADRs) — the only file here that maps cleanly to a public open-source convention. |
| `TASKS.json` | Internal task ledger used during development. |
| `STATUS.json` | Current-phase tracker consumed by `ops/weavory-dashboard.html`. |
| `RISKS.json` | Risk register with mitigation status. Cross-referenced from `docs/SECURITY.md`. |
| `BACKLOG.json` | Deferred / post-v0.1 items. |
| `WORKLOG.md` | Chronological engineering log. |
| `TEST_MATRIX.md` | Test-case inventory. Duplicates what `pnpm test` already reports; retained as a decision-trace artifact. |
| `JUDGE_GATES.md` | Acceptance-criteria document from early development. |

## Why are these public?

This repo is open-source under Apache-2.0. Engineering process
transparency is a deliberate choice — regulated-industry evaluators
often want to see how decisions were made, not just the final code.
The files here are kept in the repository for provenance, not because
they are operator-facing.

If you are evaluating weavory for a project, start with
[`../docs/README.md`](../docs/README.md) and the docs index in
[`../README.md`](../README.md). This directory is for future me, and
for auditors who want the full trail.
