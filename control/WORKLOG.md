# weavory.ai — WorkLog

Chronological engineering log. One entry per meaningful work unit. Never fabricated.

---

## 2026-04-21

### W-0001 · Project directory tree created
- Created `/Users/deepakzedler/Documents/RAW/weavory/` with full planned layout: `src/{mcp/tools,core,store,coord,trust,obs}`, `control/`, `ops/data/`, `scripts/{collect,verify}`, `dashboard/`, `examples/`, `docs/`, `tests/{unit,integration,judge}`, `.github/workflows/`.
- Status: complete.

### W-0002 · Bootstrap package.json, tsconfig.json, .gitignore
- `package.json`: `@weavory/mcp` scope, `weavory` binary, scripts for `dev`, `build`, `test`, `coverage`, `collect:*`, `verify:gate1..7`, `dashboard:serve`, `lint`. Dependencies pinned to `@modelcontextprotocol/sdk`, `@noble/ed25519`, `@noble/hashes`, `hono`, `zod`. Dev deps: `vitest`, `tsx`, `typescript`, `@types/node`, `@vitest/coverage-v8`.
- `tsconfig.json`: `"strict": true` + `noUnusedLocals/Parameters`, `noImplicitReturns`, ES2022 target, ESNext module.
- `.gitignore`: excludes `node_modules/`, `dist/`, `coverage/`, `.env*`, LanceDB/DuckDB local data, keys. Keeps `ops/data/.gitkeep`.
- Status: complete.

### W-0003 · Seed control files
- Seeded `control/MASTER_PLAN.md` (condensed plan), `control/DECISIONS.md` (7 ADRs covering name, stack, schema, API, NANDA alignment, gate order), `control/TASKS.json` (20+ tasks across phases A-F with real dependencies), `control/STATUS.json` (current phase=A, next_gate=1), `control/RISKS.json` (7 risks from plan), `control/BACKLOG.json` (10 Phase-G items gated behind Gate 7), `control/WORKLOG.md` (this file), `control/TEST_MATRIX.md` (6 core + 4 storage + 4 coord + 4 trust + 3 MCP + 5 integration planned tests), `control/JUDGE_GATES.md` (seven gates each with a reproducible verification script).
- No fabricated progress. STATUS.json correctly shows `last_gate_passed: null`.
- Status: complete.

### W-0004 · Dashboard shell
- Built `ops/weavory-dashboard.html`: single static page, no external deps. Fetches `../control/STATUS.json`, `../control/TASKS.json`, `../control/RISKS.json`, `./data/{git,tests,coverage,runtime,gates}.json`. Renders 12 sections matching the plan. When a source is missing, the card displays "Not collected yet". No inline fabricated values.
- Added `scripts/serve-dashboard.ts` so `pnpm dashboard:serve` exposes the repo root on port 4317 (resolves `file://` CORS issues).
- Status: complete.

### W-0005 · Git collector + Gate 1 script
- Built `scripts/collect/git.ts`: writes `ops/data/git.json` with `schema_version`, `is_git_repo`, `branch`, `head`, `status_counts`, `changed_files`, `recent_commits`. Emits a valid document even when the repo is not yet a git repo (branch="UNKNOWN", empty arrays). Never fabricates commit data.
- Built `scripts/verify/gate1.sh`: four-step check (control files, dashboard, node project, git collector). Executable bit set.
- Status: complete.

### W-0008 · Git init + first commit
- `git init`; branch = `main`.
- Staged 17 files. First commit `ae65da1` with message mapping to W-0001..W-0008.
- Status: complete.

### Gate 1 — PASS @ ae65da1 (pre-rewrite)
- `pnpm install` resolved 197 packages in 2.1s. `tsx` v4.21.0 / Node v23.7.0 / pnpm 10.30.3.
- `pnpm exec tsx scripts/collect/git.ts` wrote `ops/data/git.json` — real branch, real HEAD, 1 real commit, no fabricated entries.
- `bash scripts/verify/gate1.sh` — 4/4 checks green. Recorded in `ops/data/gates.json`.
- Phase A complete. STATUS.json bumped: `current_phase=B`, `last_gate_passed=1`, `next_gate=2`.

### GitHub setup · origin/main live at DeepakKTS/weavory.ai (private)
- Local git identity set to `DeepakKTS <thoppudusudharsana.d@northeastern.edu>` for this repo.
- Rewrote author/committer on the 2 existing commits via `filter-branch` (unpushed history; safe). New hashes: `724aa02` root, `1ed1fb6` Gate-1 commit.
- Created private repo `DeepakKTS/weavory.ai` on GitHub using a PAT read from `MassClaw/.git/config` (never typed in transcript).
- Added `origin` remote with URL-embedded PAT (matching MassClaw pattern; stays local in `.git/config`, never committed).
- Remote had an auto-generated Initial commit (`c5c31e3`) with LICENSE + placeholder README + Python template .gitignore. Per user decision, merged with `--allow-unrelated-histories`:
  - Kept my Node/TS-focused .gitignore.
  - Kept MIT LICENSE.
  - Replaced placeholder README with a proper top-level README (no fabricated status).
- Merge commit: `6e25d48`. Pushed `c5c31e3..6e25d48` to origin/main. Branch tracks `origin/main`.

### W-0010..W-0012 · Phase B core protocol — all green
- **W-0010 belief schema:** `src/core/schema.ts` (Zod-validated `BeliefPayload`, `SignedBelief`, `StoredBelief`, `AuditEntry`, `GENESIS_PREV_HASH`). Belief is NANDA AgentFacts superset; helpers `agentFactToBelief` / `beliefToAgentFact` in `src/core/belief.ts` round-trip cleanly.
- **W-0010 canonicalization:** `canonicalJson` is sorted-keys, no whitespace, UTF-8 bytes; stable under nested key reordering; rejects NaN/Infinity; drops `undefined`. `beliefId = blake3(canonical_bytes(payload))`.
- **W-0011 signing:** `src/core/sign.ts` Ed25519 via `@noble/ed25519` v2 + sync sha512 from `@noble/hashes`. `signBelief` / `verifyBelief` / `generateKeyPair` / `signerIdOf` / `parseSignerId`. Verification returns typed `{ok}`/`{ok:false, reason: "id_mismatch"|"bad_signature"|"schema"}`.
- **W-0012 audit chain:** `src/core/chain.ts` (`computeEntryHash`, `makeAuditEntry`, `verifyChain`) + `src/store/audit.ts` in-memory `AuditStore` with `append`/`head`/`length`/`entries`/`verify`. Genesis sentinel is 32 zero bytes.
- **Tests (source of truth: `ops/data/tests.json`):** 33/33 passing — 17 belief, 8 sign, 8 chain. Covers TEST_MATRIX T-C-001..T-C-006 + T-S-003.
- **Type check:** `pnpm exec tsc --noEmit` clean (strict: true, no `any` in src/).
- **Vitest config:** JSON reporter writes to `ops/data/tests.json` via existing `pnpm test` script. Dashboard reads it directly.
