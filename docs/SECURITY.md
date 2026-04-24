# weavory.ai — Security Posture

> **Scope.** What the weavory substrate protects, what it mitigates
> partially, and what is deliberately out of scope. Honest and short.
> Cross-references [`docs/COMPLIANCE.md`](./COMPLIANCE.md) for the
> framework-control mapping.

---

## Protected (enforced by code)

| # | What | How |
|---|------|-----|
| 1 | Every belief is attributable | Ed25519 signing via `@noble/ed25519`; `signer_id` is the hex public key. Forgery requires the signer's private key, which is derived via HKDF-SHA256 from a secret seed the operator supplies. |
| 2 | Belief id is tamper-evident | `id = BLAKE3(canonical_payload)` — any byte change produces a different id. |
| 3 | Audit log is hash-chained | Each entry includes `prev_hash`; `audit.verify()` walks the chain. A retroactive edit invalidates every later hash. |
| 4 | Recall defaults to trust-gated | Default `min_trust = 0.3` (0.6 under `WEAVORY_ADVERSARIAL=1`). Unknown / low-trust signers are filtered before they can influence downstream decisions. |
| 5 | Cause chains are validated at ingest | `causes[]` ids must already exist in `state.beliefs` — dangling references are rejected before signing. |
| 6 | Unknown cause ids → clear error | `believe()` throws with the first 12 chars of each missing id. |
| 7 | Policy gate runs before any crypto / store | When `WEAVORY_POLICY_FILE` is set, `allow/deny` rules (subject globs, predicate exacts, `max_object_bytes`) are checked before signing. Denials throw structured errors; no belief or audit entry is recorded. |
| 8 | **SEC-01 · Default payload cap** | `believe()` enforces a 1 MiB default `max_object_bytes` when **no** policy is loaded. Rejects with `OversizedPayloadError`. Policy, if present, can raise the cap up to 16 MiB. Fail-closed. |
| 9 | **SEC-02 · Subscription DoS cap** | `subscribe()` caps `state.subscriptions.size` at `subscriptionsCap` (default 10 000). Override via `WEAVORY_MAX_SUBSCRIPTIONS`. Garbage values → warn-and-default. |
| 10 | **SEC-03 · Malformed incident rejected at load** | `loadIncident()` parses JSON, enforces `schema_version == "1.0.0"`, then Zod-validates the outer record shape before `rehydrateState`. Interior belief / audit records are still parsed deeply by their own schemas. |
| 10a | **SEC-07 · Per-signer rate limit** | Write operations (`believe`, `subscribe`, `attest`, `forget`) enforce a fixed-window-per-second cap keyed on `signer_id`. Default 100 req/sec (normal) · 10 req/sec (`WEAVORY_ADVERSARIAL=1`). Override via `WEAVORY_RATE_LIMIT_PER_SIGNER=<int>`; `0` disables. Rejects with `RateLimitError` before any crypto or store work. Per-signer buckets — one misbehaving agent cannot throttle others. |
| 11 | Audit chain tamper on disk | `weavory start` with `WEAVORY_PERSIST=1` re-verifies the rehydrated chain. A break exits with code 3 + `bad_index` + reason. |
| 12 | Runtime tamper alarm | `scanForTamper()` writes `runtime.json.tamper_alarm` so dashboards + on-call see chain breaks as they happen. |
| 13 | Incident export is atomic | `exportIncident` writes to `tmp` then renames, so half-written files never land under `ops/data/incidents/`. |
| 14 | Zod strict mode on every public schema | Unknown fields rejected; unchecked values can't slip through the MCP tool inputs. |
| 15 | Docker default image is non-root | `Dockerfile` creates uid 10001 with `/usr/sbin/nologin`; no network ingress; tini as PID 1 for clean signals. |
| 16 | No network egress by default | Substrate is stdio-only. No outbound HTTP from the engine. |

---

## Mitigated (defensive behavior, but operator still owns the trust boundary)

| # | Concern | Mitigation | Residual risk |
|---|---------|------------|----------------|
| M-1 | Persistent data dir corruption | JSONL parser skips invalid / truncated lines with structured warnings. DuckDB uses WAL recovery on re-open. | If an attacker has write access to the data dir AND to the audit chain, they can silently truncate — but the hash chain + startup verify will still trip. |
| M-2 | Policy file misconfiguration | Malformed JSON / schema-invalid / wrong version → CLI exits 4 with actionable message. Never silently degrades to "no policy". | Operator must actually set `WEAVORY_POLICY_FILE` — absence of the env var yields permissive defaults (with the SEC-01 hard payload cap still in place). |
| M-3 | Oversized object (DoS) | Default 1 MiB cap (SEC-01) + policy override + per-signer rate limit (SEC-07, default 100/sec → 10/sec under `WEAVORY_ADVERSARIAL=1`). | Under an explicit `WEAVORY_RATE_LIMIT_PER_SIGNER=0` override, small-but-valid writes can still fill disk under `WEAVORY_PERSIST=1`. Rate-limiter buckets are not evicted within a single process; size is bounded by distinct signers seen. |
| M-4 | Subscription flood (DoS) | Default 10 000 cap (SEC-02) + env override. | Caller who holds a subscription can keep its queue growing up to `queue_cap` (1 000 default). Acceptable at cap × cap = bounded memory. |
| M-5 | Forged approval via unknown signer | Adversarial mode raises trust floor; unknown signer sits at neutral 0.5 < 0.6 floor → quarantined. See `examples/bfsi_claims_triage.ts`. | Operator must set `WEAVORY_ADVERSARIAL=1`. Default mode has the lower 0.3 floor — still filters obviously-untrusted, but demo scenarios should explicitly enable adversarial. |
| M-6 | Stale subscription queues | Per-subscription `queue_cap` (default 1 000) bounds memory; oldest beliefs drop when the queue overflows. | Dropped beliefs are counted (`dropped_count`) but not resurrected. This is a design choice, not a gap. |

---

## Deferred / out of scope (honestly named)

Not shipped — tracked in [`control/RISKS.json`](../control/RISKS.json) and
[`control/BACKLOG.json`](../control/BACKLOG.json).

### SEC-04 · Path resolution / symlink hardening

`WEAVORY_DATA_DIR` and `WEAVORY_POLICY_FILE` are resolved via
`path.resolve()` and opened directly. We do **not** check for symlink
escape or restricted path prefixes. The trust boundary is the operator
who starts the process — they supply the paths and govern filesystem
permissions.

**What it means.** If an attacker can control the process's environment
AND place symlinks in the target dir, they could read/write arbitrary
files the weavory user account can access. This is the same posture
Node's `fs` has.

**Mitigation today.** Log the resolved absolute path once at startup
(stderr), so operators can see exactly which file the server will
touch. No code change beyond that in P1-4.

**If this ever matters.** Run weavory with a dedicated service user,
chroot or namespace the data directory, and audit the env vars in CI.

### SEC-05 · Incident export may contain sensitive data

`exportIncident` writes the full `object` field of every stored belief
into the JSON dump under `ops/data/incidents/incident-<ts>.json`. The
operator controls whether `object` contains PII; weavory does not
redact.

**What it means.** An incident file is as sensitive as the beliefs it
captures. Treat it as classified as the source data.

**Mitigation today.** The incidents directory is gitignored by default.
Filesystem permissions govern who can read it. The `reason` field on
`exportIncident()` is an operator-supplied string that should name the
data classification if relevant.

**If this ever matters.** Either (a) set `WEAVORY_POLICY_FILE` with
`predicate_deny` rules so sensitive predicates never enter the store,
or (b) run incident export through a redaction pass in your operational
tooling before the file leaves the host.

### SEC-06 · Stderr logs include absolute paths

Startup emits:

```
[weavory] persistence enabled (kind=jsonl dir=/var/lib/weavory)
[weavory] policy loaded from /etc/weavory/policy.json
```

**What it means.** Anyone with read access to stderr (container logs,
systemd journal) can see where weavory is writing to. This may leak
deployment topology but does not leak beliefs, signatures, or seeds.

**Mitigation today.** None beyond filesystem permissions on the log
sink. Seeds (`signer_seed`) are never logged.

**If this ever matters.** Route stderr through a filter in your
logging pipeline, or run weavory with relative paths if your
deployment allows it.

---

## Rate limits (SEC-07 — shipped)

Per-signer write-rate limiting is enforced on all four write tools
(`believe`, `subscribe`, `attest`, `forget`). Keyed on the derived
`signer_id` so the same `signer_seed` shares one bucket across calls;
fresh signers get their own bucket.

- **Normal mode:** 100 req/sec per signer — well above any realistic
  agent pipeline (the BFSI demo writes ~6 beliefs in ~20 s).
- **Adversarial mode** (`WEAVORY_ADVERSARIAL=1`): 10 req/sec — tight
  enough that a scripted flood is visibly rejected.
- **Override:** `WEAVORY_RATE_LIMIT_PER_SIGNER=<int>` (req/sec).
  `0` disables the limiter entirely.
- **Error:** `RateLimitError` thrown before any crypto or store work;
  MCP callers see `isError: true` with the 12-char signer prefix, the
  configured limit, and milliseconds until the current window resets.
- **Isolation:** per-signer buckets — one misbehaving agent cannot
  throttle its peers.

Rejected requests leave no state mutation — no audit entry, no
subscription row, no stored belief. Read operations (`recall`) are
exempt; CPU-bound read flooding is a different surface, bounded by
the belief set and `top_k`.

**Not yet shipped on this surface:** bucket eviction / TTL (bucket map
size grows to distinct signers seen; acceptable for a single-process
server with a bounded agent set) and global-per-process write rate (per-
signer only today).

---

## Encryption at rest

Not provided. JSONL and DuckDB files are written plaintext. Use
filesystem-layer encryption (LUKS, EFS/KMS, dm-crypt) on
`WEAVORY_DATA_DIR` if your threat model requires encrypted storage.

---

## Authentication

Not provided. Identity is proof-of-seed: holding the seed proves you
are the signer with the derived `signer_id`. Mapping those keys to
organizational identities (OIDC / SSO / SCIM) is external to the
substrate — tracked as backlog item B-0008.

---

## SEC-09 · Dashboard demo-drive endpoint (Phase O.5)

**What it is.** The dashboard sidecar (`scripts/serve-dashboard.ts`) exposes an opt-in `POST /api/demo/play` route that drives a fixed 13-event BFSI-style scenario (`scripts/demo_scenario.ts`) against its in-process `EngineState`. Purpose: pitch-video recording and live-presentation demos where the presenter wants one command to populate the dashboard with motion. **This is a sidecar-only admin route, not an MCP tool** — ADR-005's five-tool lock is untouched.

**Threat model.**

| Risk | Mitigation |
|---|---|
| Unintended exposure | Off by default. Endpoint returns HTTP 404 when `WEAVORY_ENABLE_DEMO_DRIVE` is unset — indistinguishable-from-missing. |
| Unauthenticated trigger on exposed sidecar | Non-loopback bind still requires `?token=<WEAVORY_DASHBOARD_TOKEN>` (or `X-Weavory-Token` header). Token compared in constant time via `crypto.timingSafeEqual`. |
| Resource exhaustion from repeated plays | Global rate limit: 1 play per 10 s (429 on excess). |
| Unbounded state growth | Hard cap: refuses further plays when `state.beliefs.size > 500`. Operator resets by restarting the sidecar. |
| SSRF | Scenario is fixed in `scripts/demo_scenario.ts`; no user-controlled URLs reach any network call. |
| CSRF | No cookies; token in query string / header; POST-only. Same posture as `POST /api/replay`. |
| XSS / stream exfiltration | CSP `connect-src 'self'` prevents a malicious page from streaming `/events` or posting to `/api/demo/play` even if injected. |
| Log leakage | Demo-play logs include only event count, not payloads. Token is never logged in full anywhere. |

**Enabling.**

Two env flags, both off by default:

- `WEAVORY_ENABLE_DEMO_DRIVE=1` — makes the `POST /api/demo/play` endpoint respond. `/api/state` starts returning `demo_drive_enabled: true` so the dashboard UI renders the "Play demo scenario" button.
- `WEAVORY_DEMO_AUTOPLAY=1` — **implies** `WEAVORY_ENABLE_DEMO_DRIVE=1` AND schedules one scenario play 3 s after the sidecar starts listening. Helpful for pitch-video recording: one command boots a dashboard that populates itself hands-free.

Presenters can wrap both in the helper script:

```bash
pnpm dashboard:demo      # sets both env flags + starts the sidecar
```

**Defaults when enabled.** Adversarial mode is turned on by default for demo-mode sidecars (unknown signers → quarantine events → LED flashes red on the dashboard). The caller can override by passing a pre-built `EngineState` with `adversarialMode = false`.

**What NOT to do.**

- **Do not expose a demo-drive sidecar to the public internet.** The feature is designed for localhost presentations. If you must expose it (e.g., for a remote demo), set a strong `WEAVORY_DASHBOARD_TOKEN` AND a firewall ACL restricting source IP.
- **Do not enable demo-drive on the same process that serves a real MCP client via stdio.** The demo scenario writes real beliefs into the engine that become visible to any live `recall()` caller.

---

## Reporting security issues

This is an early-stage open-source substrate. For suspected
vulnerabilities, **please do not open a public issue** — email the
maintainer or open a GitHub security advisory at
<https://github.com/DeepakKTS/weavory.ai/security/advisories/new>.

For non-sensitive questions, open a regular issue with the `security`
label at <https://github.com/DeepakKTS/weavory.ai/issues>.

---

*Last reviewed 2026-04-22.*
