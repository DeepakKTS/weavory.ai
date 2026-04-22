# weavory.ai — Deployment

Scope: what an operator needs to run weavory beyond a laptop demo.
For the "just get it running" path, see [INSTALL.md](./INSTALL.md).

## Table of contents

- [Environment variables](#environment-variables)
- [Persistence](#persistence)
- [Data directory layout](#data-directory-layout)
- [Adversarial / Responsible-AI mode](#adversarial--responsible-ai-mode)
- [Policy file](#policy-file)
- [Docker](#docker)
- [Health / liveness](#health--liveness)
- [Single-writer invariant](#single-writer-invariant)
- [Out-of-scope for this release](#out-of-scope-for-this-release)

---

## Environment variables

Every flag is optional. Defaults preserve Phase-1 semantics.

| Variable | Default | Effect |
|----------|---------|--------|
| `WEAVORY_PERSIST` | unset | Enable persistence when set to `1`, `true`, `on`, `yes`. When unset, state is in-memory only (restart = empty). |
| `WEAVORY_STORE` | `jsonl` | Persistence backend: `jsonl` (default, pure-Node, synchronous) or `duckdb` (optional, WAL-backed). DuckDB falls back to JSONL if its native binding can't load — this is by design, see [§ DuckDB fallback](#duckdb-fallback). |
| `WEAVORY_DATA_DIR` | `./.weavory-data` | Where persistent files live. Created on first write. |
| `WEAVORY_POLICY_FILE` | unset | Path to a JSON policy evaluated before every `believe()`. See [§ Policy file](#policy-file). |
| `WEAVORY_ADVERSARIAL` | unset | `1` raises the default `recall` trust floor from 0.3 → 0.6. Documented Responsible-AI posture. |
| `WEAVORY_VERIFY_ON_WRITE` | unset | `1` forces a defensive Ed25519 verify on every `believe()` after signing (~10× slower). Useful during protocol changes or adversarial audits. |
| `WEAVORY_RUNTIME_WRITER` | `on` (outside tests) | `off` disables atomic snapshots to `ops/data/runtime.json`. Leave `on` in production so the dashboard reflects live state. |

No other env vars are read by the server. `ANTHROPIC_API_KEY` is only used by Gate 7's judge-simulation script in CI, never by weavory itself.

---

## Persistence

Two backends, both opt-in via `WEAVORY_PERSIST=1`. Both persist beliefs,
the audit chain, and trust attestations — subscriptions are ephemeral
by design (they bind to a client connection).

| Backend | `WEAVORY_STORE` | Durability | Native deps |
|---------|-----------------|-----------|-------------|
| JSONL   | `jsonl` (default) | `fs.appendFileSync` — the line is on-disk before `believe()` returns. Crash-consistent. A crash mid-write can leave a truncated final line that is skipped on reload with a warning. | None |
| DuckDB  | `duckdb` | DuckDB's WAL; crash-consistent via WAL replay on open. `SIGKILL` may lose the last few ms because the Node binding is async. Ordering is still strict (single-threaded write queue). | `@duckdb/node-api` (optional) |

### DuckDB fallback

If `WEAVORY_STORE=duckdb` but the binding can't load — missing binary,
ABI mismatch, permission issues — the factory logs one stderr warning and
transparently opens a JSONL store instead. The server still starts. This
is the same graceful-degradation pattern Node uses for optional native
modules (e.g. `fsevents` on Linux).

```
[weavory] [persist] duckdb backend unavailable (<reason>); falling back to jsonl. This is expected when the @duckdb/node-api binary is not installed for the current platform; see docs/DEPLOYMENT.md.
```

If you require DuckDB specifically, check:
1. `pnpm install` actually installed `@duckdb/node-api` (it's an
   `optionalDependencies`; `--ignore-optional` or restricted registries
   will skip it).
2. The platform/arch is supported by the prebuilt addon. DuckDB's Node
   binding ships prebuilts for `darwin-arm64`, `darwin-x64`,
   `linux-x64`, `linux-arm64`, `win32-x64`.
3. No `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES` is interfering.

---

## Data directory layout

### JSONL

```
$WEAVORY_DATA_DIR/
├── beliefs.jsonl      # one StoredBelief per line; last-write-wins on id
├── audit.jsonl        # one AuditEntry per line; strict append order
└── trust.jsonl        # one {signer_id, topic, score, recorded_at} per line
```

Each file begins with a `{"_meta": {...}}` line the parser skips. Format
evolution is a meta-version bump.

### DuckDB

```
$WEAVORY_DATA_DIR/
└── weavory.duckdb     # single file, holds beliefs/audit/trust tables + WAL
```

Schema lives in `src/store/persist_duckdb.ts` (three tables, one
sequence). DuckDB acquires an exclusive lock on the file — see
[§ Single-writer invariant](#single-writer-invariant).

### Restart recovery

On `weavory start` with persistence enabled:

1. Open the configured store (JSONL or DuckDB).
2. Read all beliefs, audit entries, trust rows into memory.
3. Rehydrate the `EngineState` via `restoreFromRecords` (bypassing the
   persist hook so rehydrate doesn't duplicate records on disk).
4. Verify the audit chain.
5. If the chain is broken → **exit code 3** with a clear message. This
   is tamper-detection-on-restart; a broken chain means the data
   directory has been touched by something other than weavory.
6. Otherwise, attach the store for future writes.

---

## Adversarial / Responsible-AI mode

`WEAVORY_ADVERSARIAL=1` raises the default `recall` trust floor
`min_trust` from 0.3 to 0.6. Rationale: **unknown signers default to 0.5
neutral trust**, so in adversarial mode they are below the floor and
don't appear in recalls until an explicit attestation raises them.

Per-call `min_trust` overrides remain in force. Audit / forensic views
typically pass `min_trust: -1` to see everything including
quarantined / low-trust claims.

Leave it off for demo / dev. Turn it on for:
- Regulated-workflow demos (BFSI, healthcare scenarios)
- Incident-drill demos (`examples/wall_incident.ts`)
- Any deployment where clients should earn trust, not inherit it

---

## Policy file

Set `WEAVORY_POLICY_FILE=/path/to/policy.json`. Loaded once at startup;
an invalid policy exits with code 4 (not silent).

```json
{
  "version": "1.0.0",
  "subject_allow": ["scene:*", "agent:*"],
  "subject_deny":  ["scene:admin/*"],
  "predicate_allow": ["observation", "claim", "capability.offers"],
  "predicate_deny":  ["internal.secret", "pii.ssn", "pii.dob"],
  "max_object_bytes": 65536
}
```

Evaluation order (short-circuit on first deny):
1. `max_object_bytes` (UTF-8 byte count)
2. `predicate_deny` (exact match)
3. `predicate_allow` (exact match; absent or empty = allow all)
4. `subject_deny` (glob: trailing `*` = prefix, else exact)
5. `subject_allow` (glob; absent or empty = allow all)

Denials surface to MCP clients as a structured error with the rule name
and a human-readable message; no belief or audit entry is recorded on
denial.

Full schema + examples are in `src/engine/policy.ts`.

---

## Docker

A multi-stage `Dockerfile` is included at the repo root:

```dockerfile
# Build stage → tsc into dist/
FROM node:22-slim AS build
...

# Runtime stage → node:22-slim, prod deps only, dist + docs
FROM node:22-slim AS runtime
...
```

Typical production compose fragment:

```yaml
services:
  weavory:
    build: .
    environment:
      WEAVORY_PERSIST: "1"
      WEAVORY_STORE: "jsonl"          # or "duckdb" if your image ships the binary
      WEAVORY_DATA_DIR: "/data"
      WEAVORY_ADVERSARIAL: "1"
      WEAVORY_POLICY_FILE: "/policy/default.json"
    volumes:
      - weavory-data:/data
      - ./policy:/policy:ro
    stdin_open: true     # stdio MCP needs STDIN
    tty: false
volumes:
  weavory-data:
```

Why JSONL in Docker by default: the upstream `@duckdb/node-api`
prebuilds cover `linux-x64` and `linux-arm64`, but if you strip
optionalDependencies during image build or run `pnpm install --prod`
under `--ignore-optional`, DuckDB won't be in the image — the fallback
handles it cleanly. Either accept the fallback or `pnpm install
@duckdb/node-api` explicitly in the build stage.

---

## Health / liveness

Weavory is stdio-only; it has no HTTP health endpoint. For container
platforms that probe via command exec, check process liveness and the
runtime snapshot:

```bash
# "is the process alive"
docker compose exec weavory pgrep -f 'node.*cli.js start'

# "is it writing snapshots" — runtime.json is touched on every op
docker compose exec weavory stat -c '%Y' /data/../ops/data/runtime.json
```

A `weavory health` subcommand that returns structured JSON and a
non-zero exit on chain-failure is on the backlog (P1-5).

---

## Single-writer invariant

**Only one weavory process should own a given `WEAVORY_DATA_DIR`.**

- JSONL: no lock enforcement. Two concurrent writers would interleave
  lines; the parser tolerates this for individual records but ordering
  guarantees break. Don't do this.
- DuckDB: enforced by DuckDB's own exclusive lock. The second process
  fails at open time — correct behavior.

Multi-process federation (`libp2p` gossip) is on the post-hackathon
backlog (B-0006).

---

## Out-of-scope for this release

Honestly tracked in `control/BACKLOG.json`. Calling them out here so
operators aren't surprised:

- **No TLS / mTLS.** stdio transport only.
- **No encryption at rest.** Use filesystem-layer encryption on
  `WEAVORY_DATA_DIR` if your threat model requires it.
- **No RBAC / SSO.** Identity is by Ed25519 key; mapping to
  organizational users is external.
- **No multi-tenant isolation.** One data dir per deployment.
- **No HTTP transport.** stdio only. Teams wrapping weavory behind a
  REST/gRPC layer are responsible for their own transport adapter.
- **No Kubernetes helm chart.** Docker compose only.
- **No autoscaling.** Single process, single writer.

These are deliberate scope boundaries for Phase 1, not accidental gaps.
