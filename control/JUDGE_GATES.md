# weavory.ai — Judge Gates

Seven gates. Each has a machine-verifiable pass criterion and a reproducible script. Gates must be passed **in order**; Phase G work (arena extensions, federation, merge variants) is forbidden until Gate 7 is green.

A gate is "green" iff its verification script exits 0 **in CI** (not just locally) and the run artefact is recorded in `ops/data/gates.json`.

---

## Gate 1 — Bootstrap

**Pass criterion:** Repo boots, all nine `/control/` files exist, `/ops/weavory-dashboard.html` exists and renders, `/ops/data/git.json` is producible by the collector.

**Verification:** `scripts/verify/gate1.sh`
- Assert every file in `control/` exists.
- Assert `ops/weavory-dashboard.html` exists.
- Assert `pnpm install` completes.
- Assert `pnpm collect:git` produces `ops/data/git.json` with `schema_version` and `branch` fields.

---

## Gate 2 — MCP surface

**Pass criterion:** All five MCP tools are registered and callable with valid Zod-schema responses.

**Verification:** `scripts/verify/gate2.sh`
- Start server in background.
- Use an MCP test harness (or `mcp-inspector`) to enumerate tools; assert names match the whitelist `[believe, recall, subscribe, attest, forget]`.
- For each tool: call with a minimal valid payload; assert response matches its declared schema.
- Negative: call `believe` with a missing required field; assert structured validation error.

---

## Gate 3 — Two-agent belief exchange

**Pass criterion:** `examples/two_agents_collaborate.ts` exits 0; both agents produce the scripted correct answer after exchanging a belief via weavory.

**Verification:** `scripts/verify/gate3.sh`
- Start weavory server (fresh data dir).
- Run the example script in-process with two distinct signer keys.
- Assert: Agent A's `believe(...)` returns a `belief_id`. Agent B's `recall(...)` in a fresh session returns that belief. Both produce the expected downstream answer.

---

## Gate 4 — Trust & quarantine

**Pass criterion:** Unsigned and low-trust beliefs are quarantined from default `recall`; quarantine count is observable via `ops/data/runtime.json`.

**Verification:** `scripts/verify/gate4.sh`
- Start server.
- Inject: (a) a valid signed belief from a trusted signer; (b) an unsigned claim; (c) a signed claim from a signer below trust threshold.
- Assert: default `recall(query)` returns only (a). `recall(query, min_trust=0)` returns all three.
- Assert: `ops/data/runtime.json.quarantine_count` ≥ 2.

---

## Gate 5 — `as_of` recall

**Pass criterion:** Bi-temporal queries return the belief state as of any prior timestamp.

**Verification:** `scripts/verify/gate5.sh`
- Write belief B1 at T0.
- Invalidate B1 via a new belief B2 at T1 > T0.
- Assert: `recall(query)` returns B2; `recall(query, as_of=T0 + 1ms)` returns B1.

---

## Gate 6 — Fresh-machine setup

**Pass criterion:** On a clean Ubuntu + macOS GitHub Actions runner, `npx @weavory/mcp start` succeeds and Gate 3 script passes.

**Verification:** `.github/workflows/fresh-machine.yml`
- Matrix: `ubuntu-latest`, `macos-latest`.
- Steps: `git clone`, `npm install -g pnpm`, `pnpm install`, `pnpm build`, `scripts/verify/gate3.sh`.
- Artefact: logs + `ops/data/gates.json` updated with timestamps.

---

## Gate 7 — README-only judge simulation

**Pass criterion:** A fresh Claude/OpenClaw-compatible agent, given only `docs/README.md`, completes the scripted judge task without additional human guidance.

**Verification:** `scripts/verify/gate7.sh` + `tests/judge/gate7_simulation.ts`
- Spin up weavory server.
- Spawn a minimal agent harness that:
  1. Reads `docs/README.md` verbatim.
  2. Receives the judge prompt (`tests/judge/judge_prompt.txt`).
  3. Attempts the task using only MCP tools exposed by weavory.
- Assert: task completes; transcript logged to `ops/data/gate7.log`.
- Dress-rehearsal requirement: script must pass **three** independent runs on **three** different VMs before submission.

---

## Audit trail

Every gate pass is recorded in `ops/data/gates.json`:

```json
{
  "gate": 3,
  "passed_at": "2026-05-02T14:12:03Z",
  "commit": "abc1234",
  "script": "scripts/verify/gate3.sh",
  "runner": "local/macos-15",
  "notes": "Two-agent exchange verified; signer keys regenerated per run."
}
```

Dashboard reads this file. Never fabricated.
