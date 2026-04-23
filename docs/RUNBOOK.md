# weavory.ai — Runbook

Common operational scenarios. Each entry is a short, honest how-to tied
to real commands and real files.

## Table of contents

- [Install / first-run failures](#install--first-run-failures)
- [Routine start / stop](#routine-start--stop)
- [Changing persistence backends](#changing-persistence-backends)
- [Inspecting what's in the data directory](#inspecting-whats-in-the-data-directory)
- [Chain-broken on restart](#chain-broken-on-restart-exit-code-3)
- [Policy denial debugging](#policy-denial-debugging)
- [Incident export + replay](#incident-export--replay-forensic-workflow)
- [Recovering from a bad policy load](#recovering-from-a-bad-policy-load-exit-code-4)
- [Reclaiming disk space](#reclaiming-disk-space-jsonl)
- [Rotating signer keys](#rotating-signer-keys)

---

## Install / first-run failures

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `pnpm install` fails during `@duckdb/node-api` download | Registry restriction or offline install | DuckDB is an **optional** dep. Re-run with `pnpm install --no-optional`, the system still ships JSONL persistence. |
| `pnpm build` fails with TS errors | Stale dist/ from an older Node version | `rm -rf dist && pnpm build` |
| `pnpm verify:gate3` fails with "demo exit N" | Likely a Node version mismatch (< 20) | Upgrade to Node ≥ 20; CI runs Node 22. |
| `pnpm test` hangs on macOS arm64 | Vitest's fs.watch on tmp can deadlock under heavy IO | `pnpm test -- --no-watch` (the `test` script already uses `--run`, but double-check against a local override) |

---

## Routine start / stop

```bash
# Foreground (dev)
pnpm dev

# Production — built dist + systemd-friendly
node dist/cli.js start

# With persistence
WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/var/lib/weavory node dist/cli.js start

# Stop
# send SIGTERM; runtime_writer flushes a final snapshot with server_status="stopped"
kill -TERM <pid>
```

On clean shutdown (`SIGTERM`, `SIGINT`) the runtime writer flushes one
final snapshot. `ops/data/runtime.json` ends up at `server_status:
"stopped"`. That's the healthy shutdown signature.

On `SIGKILL`: no final snapshot. Chain is still valid because every
audit entry is written synchronously (JSONL) or WAL-backed (DuckDB).

---

## Changing persistence backends

Switching `jsonl` ↔ `duckdb` requires **exporting and re-importing**
because the on-disk formats are different. There is no built-in
migration tool in Phase 1. Rough procedure:

```bash
# 1. Stop weavory
kill -TERM <pid>

# 2. Dump current state via incident export
pnpm exec tsx scripts/verify/gate_tamper.sh      # convenient reference
# or call exportIncident() programmatically against the running state
#   then weavory replay is how you'd verify the dump

# 3. Start a fresh server on a NEW data dir with the new backend
WEAVORY_PERSIST=1 WEAVORY_STORE=duckdb WEAVORY_DATA_DIR=/var/lib/weavory-new \
  node dist/cli.js start

# 4. Replay each belief via weavory.believe using a client script
```

Migration tooling (`weavory migrate --from jsonl --to duckdb`) is on the
P2 backlog.

---

## Inspecting what's in the data directory

### JSONL

```bash
# Belief count (excluding meta line)
tail -n +2 $WEAVORY_DATA_DIR/beliefs.jsonl | wc -l

# Audit chain length
tail -n +2 $WEAVORY_DATA_DIR/audit.jsonl | wc -l

# Last 5 beliefs (most recent lines)
tail -5 $WEAVORY_DATA_DIR/beliefs.jsonl | jq .

# Verify the audit chain off-line
tail -n +2 $WEAVORY_DATA_DIR/audit.jsonl | \
  node -e '
    const lines = require("fs").readFileSync(0, "utf8").trim().split("\n");
    const { verifyChain } = await import("./dist/core/chain.js");
    const entries = lines.map((l) => JSON.parse(l));
    console.log(verifyChain(entries));
  ' --input-type=module
```

### DuckDB

```bash
# Row counts via the CLI bundled with @duckdb/node-api
node -e '
import { DuckDBInstance } from "@duckdb/node-api";
const db = await DuckDBInstance.create("'$WEAVORY_DATA_DIR'/weavory.duckdb");
const c = await db.connect();
console.log(await (await c.run("SELECT COUNT(*) AS n FROM beliefs")).getRowObjects());
console.log(await (await c.run("SELECT COUNT(*) AS n FROM audit")).getRowObjects());
console.log(await (await c.run("SELECT COUNT(*) AS n FROM trust")).getRowObjects());
' --input-type=module
```

---

## Chain-broken on restart (exit code 3)

Symptom: `weavory start` prints something like:

```
[weavory] fatal: persistence audit chain is BROKEN on restart
  (bad_index=<N> reason=<...>). This is tamper detection at work —
  investigate before restarting.
```

Investigation steps:

1. **Back up the data dir.** `cp -r $WEAVORY_DATA_DIR $WEAVORY_DATA_DIR.broken.$(date +%s)`
2. **Don't just restart.** A broken chain is either tamper OR disk
   corruption; both are red flags.
3. **Identify the bad entry.** The stderr message includes
   `bad_index`. For JSONL, open `audit.jsonl` and look at line
   `bad_index + 1` (meta line offset).
4. **Export an incident from the last known good state** if you have
   one. The incident JSON makes the tamper reviewable.
5. **Decide.** If this is a drill (you tampered to test the alarm), 
   clear the data dir and restart. If this is production, treat as a
   security incident per your organization's runbook.

The bundled adversarial drill demo exercises this end-to-end:
`pnpm exec tsx examples/tamper_detection.ts` writes a deliberate bad entry
and shows the alarm + incident export.

---

## Policy denial debugging

When a client's `weavory.believe` returns an error message starting
with `policy denial`, the server already tells you the rule name and
reason:

```
policy denial (predicate_allow): predicate "foo" is not on the allow-list (3 entries)
policy denial (subject_deny):    subject "scene:admin/x" matches deny pattern "scene:admin/*"
policy denial (max_object_bytes): object payload 5010 bytes exceeds max 4096
```

Actions:

- **`predicate_deny` / `subject_deny`** — the client is trying something
  the operator has explicitly forbidden. Escalate or update policy.
- **`predicate_allow` / `subject_allow`** — the client is asking for
  something not explicitly allowed. Either the client is misconfigured
  or the allow-list is too narrow.
- **`max_object_bytes`** — client is sending oversized payloads.
  Either compress / reference externally, or raise the cap (next reload).

Policy reloads require a server restart. Hot-reload is on backlog.

---

## Incident export + replay (forensic workflow)

```bash
# On a running server (programmatic — exportIncident is not exposed as an MCP tool)
# The tamper_detection.ts example demonstrates the full flow:
pnpm exec tsx examples/tamper_detection.ts

# Incidents land under ops/data/incidents/
ls -la ops/data/incidents/ | tail

# Replay a specific incident
node dist/cli.js replay --from ops/data/incidents/incident-<timestamp>.json --query ""

# Get structured JSON output for programmatic forensics
node dist/cli.js replay --from <path> --query "" --json | jq '.summary.audit'
```

The replay is read-only against rehydrated state — no writes hit disk,
no audit entries append. Safe to run on production incident artifacts.

---

## Recovering from a bad policy load (exit code 4)

Symptom: `weavory start` with `WEAVORY_POLICY_FILE=...` exits with:

```
[weavory] fatal: policy load failed: policy: <path> is not valid JSON: ...
```

or

```
[weavory] fatal: policy load failed: policy: <path> failed validation: version:Invalid literal value, expected "1.0.0"
```

Fixes:

1. `jq . $WEAVORY_POLICY_FILE` — verify it's valid JSON
2. Check `version` is exactly `"1.0.0"` (current schema)
3. Validate against the schema in `src/engine/policy.ts`
4. If you need to bypass temporarily, `unset WEAVORY_POLICY_FILE` and
   restart — the server runs with no policy (Phase-1 default)

---

## Reclaiming disk space (JSONL)

Tombstones and trust overrides accumulate lines in the JSONL log
(last-write-wins semantics mean old lines are still on disk).

Compaction for JSONL is **not yet automated**. Manual procedure:

```bash
# 1. Stop the server
# 2. Let the store load + snapshot current state via an export script (future tool)
# 3. Swap the data dir atomically
```

Until a compaction CLI ships, the pragmatic answer is to switch to
DuckDB for heavy churn — DuckDB reclaims space via `VACUUM`
automatically.

---

## Rotating signer keys

Weavory signer identities are derived deterministically from a seed
(`signerFromSeed(seed)` → HKDF-SHA256 → Ed25519 keypair). Rotation means:

1. Stop using the old seed in client code.
2. New `signer_seed` → new `signer_id` (a new hex 32-byte string).
3. Existing beliefs keep their old `signer_id`s forever — this is a
   feature, not a bug. Audit attributability must remain intact.
4. Re-attest new identity for relevant topics via `weavory.attest`.

There is no "revoke signer" operation. If a key is compromised,
attestations should be lowered to -1 (explicit distrust), which
poisons that signer across recalls.
