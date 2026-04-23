# weavory.ai — Compliance Mapping

> **Purpose.** This page maps weavory's implemented features to common
> enterprise governance / Responsible AI controls so operators can
> quickly see what's enforced by the substrate vs. what still sits with
> the deploying organization. It is a *mapping*, not a certification
> claim. Every row names the specific source file the guarantee lives in
> so engineering teams can audit it directly.

---

## Scope of this document

- **In scope:** controls implementable (or partially implementable) by a
  shared-belief coordination substrate.
- **Out of scope:** organizational controls (HR, vendor management,
  physical security), network-perimeter controls, and anything that
  requires a hosting stack beyond what weavory itself ships.

Frameworks referenced:

| Framework | Version / Ref |
|-----------|---------------|
| AICPA **SOC 2 Type II** Trust Services Criteria | 2017, revised 2022 |
| **ISO/IEC 27001:2022** | A.12 Operations Security · A.18 Compliance |
| **GDPR** (EU 2016/679) | Arts. 5, 17, 25, 30 |
| **NIST AI RMF** 1.0 | Govern, Map, Measure, Manage |
| **EU AI Act** (provisional) | Art. 10 (data governance), Art. 12 (logging), Art. 15 (accuracy / cybersecurity) |

---

## Control mapping

### Identity, authentication & attribution

| Control | Framework ref | How weavory implements it | Source |
|---------|---------------|---------------------------|--------|
| Every claim is cryptographically attributable to a signer | SOC2 CC6.1 · ISO A.9.4 · NIST AI-RMF MAP-4.1 | Each belief is Ed25519-signed; `signer_id` is the hex public key; verification is deterministic and offline-checkable. | `src/core/sign.ts`, `src/engine/ops.ts` |
| Identity is derivable from a named seed (operationally simple) | SOC2 CC6.1 | HKDF-SHA256(seed) → Ed25519 keypair; same seed → same `signer_id`. Seeds are **never** persisted. | `src/engine/state.ts` (`deriveKeyPair`) |
| Anonymous signers are supported but distinguishable | SOC2 CC6.1 | `freshSigner()` allocates a one-off keypair; the seed is not recoverable. | `src/engine/state.ts` |

### Tamper detection & audit integrity

| Control | Framework ref | How weavory implements it | Source |
|---------|---------------|---------------------------|--------|
| Append-only audit log | SOC2 CC7.2 · ISO A.12.4.1 · EU AI Act Art. 12 | `AuditStore` is append-only by type; the in-memory API has no delete or update. | `src/store/audit.ts` |
| Tamper-evident linkage across entries | SOC2 CC7.2 · NIST AI-RMF MEASURE-2.4 | BLAKE3 hash chain: `entry_hash = BLAKE3(canonical(prev_hash ‖ belief_id ‖ signer_id ‖ operation ‖ recorded_at))`. Any retroactive edit invalidates every later hash. | `src/core/chain.ts`, `src/store/audit.ts` |
| Active tamper detection on runtime state | SOC2 CC7.2 | `scanForTamper()` + `WEAVORY_ADVERSARIAL=1` raises alarm into `ops/data/runtime.json.tamper_alarm` when chain verification fails. | `src/engine/incident.ts`, `src/engine/runtime_writer.ts` |
| Incident export for post-breach forensic replay | SOC2 CC7.3 · ISO A.16 | `exportIncident()` serializes the audit chain + beliefs + trust + subscriptions into a reviewable JSON file under `ops/data/incidents/`. | `src/engine/incident.ts` |
| Forensic re-execution of past state | EU AI Act Art. 12 · NIST AI-RMF MEASURE-2.7 | `weavory replay --from <incident>` rehydrates the captured state and re-runs queries; chain verification reproduces the original ok/bad verdict. | `src/engine/replay.ts`, `src/cli.ts` |
| Tamper-on-restart detection (when persistence enabled) | SOC2 CC7.2 | On `weavory start` with `WEAVORY_PERSIST=1`, the chain is re-verified after disk rehydrate. Broken chain → exit code 3 + clear message. | `src/cli.ts` (`buildStateFromEnv`) |

### Bi-temporal accuracy & correctability

| Control | Framework ref | How weavory implements it | Source |
|---------|---------------|---------------------------|--------|
| Correct / invalidate prior claims without destroying history | GDPR Art. 17 · NIST AI-RMF MANAGE-4.1 | `forget(belief_id)` sets `invalidated_at` without removing the audit entry; the original signed belief remains in the append log with tombstone metadata. | `src/engine/ops.ts`, `src/core/schema.ts` |
| Point-in-time reconstruction (audit what was "true" at time T) | SOC2 CC7.5 · EU AI Act Art. 12 | `recall(query, as_of: <ISO>)` returns the belief state as of that instant; excludes beliefs ingested after or invalidated at/before. | `src/engine/ops.ts` (`recall`) |
| Provenance / causal chains on beliefs | EU AI Act Art. 12 · NIST AI-RMF MAP-5.2 | Beliefs carry `causes: []` — BLAKE3 ids of prior beliefs. Unknown cause ids are rejected at ingest (no dangling pointers). | `src/engine/ops.ts` (cause validation) |

### Data minimization, size limits & policy enforcement

| Control | Framework ref | How weavory implements it | Source |
|---------|---------------|---------------------------|--------|
| Allow-list / deny-list for ingested predicates or subjects | SOC2 CC6.1 · GDPR Art. 25 · EU AI Act Art. 10 | `WEAVORY_POLICY_FILE` loads a JSON policy with `{subject_allow, subject_deny, predicate_allow, predicate_deny}`. Evaluated before sign/store on every `believe`. | `src/engine/policy.ts`, `src/engine/ops.ts` |
| Per-payload size cap | SOC2 CC6.6 · ISO A.12.2 | `max_object_bytes` in the policy file, counted as UTF-8 bytes. Exceeding → deny. | `src/engine/policy.ts` |
| Schema validation on every mutation | SOC2 CC7.1 | Zod schemas on all five MCP tools; strict mode (`.strict()`) rejects unknown fields. | `src/core/schema.ts`, `src/mcp/server.ts` |

### Trust, quarantine & adversarial posture

| Control | Framework ref | How weavory implements it | Source |
|---------|---------------|---------------------------|--------|
| Per-(signer × topic) trust vectors, scored in `[-1, 1]` | NIST AI-RMF GOVERN-1.2 · EU AI Act Art. 10 | `setTrust()` updates a `Map<signer, Map<topic, score>>`; scoring is explicit, not inferred. | `src/engine/state.ts` |
| Default trust gate on every recall | SOC2 CC6.1 | `recall()` filters out any signer with topic trust < `min_trust` (default 0.3). Explicit override requires `min_trust` input. | `src/engine/ops.ts` (`recall`) |
| Adversarial mode raises the default trust floor | SOC2 CC6.1 · NIST AI-RMF MANAGE-2.3 | `WEAVORY_ADVERSARIAL=1` → default `min_trust` 0.3 → 0.6 (unknown signers are hostile-until-proven-otherwise). | `src/mcp/server.ts` (flag), `src/engine/ops.ts` (`recall`) |
| Low-trust or unsigned claims are quarantined, not returned | SOC2 CC6.1 | `quarantined` flag on `StoredBelief`; filter applied unless `include_quarantined: true`. | `src/core/schema.ts`, `src/engine/ops.ts` |

### Persistence, restart safety & data residency

| Control | Framework ref | How weavory implements it | Source |
|---------|---------------|---------------------------|--------|
| Crash-consistent persistence (opt-in) | SOC2 CC7.4 · ISO A.17 | JSONL backend: `fs.appendFileSync` — durable before the call returns. DuckDB backend: WAL-backed, crash-consistent, opt-in via `WEAVORY_STORE=duckdb`. | `src/store/persist_jsonl.ts`, `src/store/persist_duckdb.ts` |
| Data residency is operator-controlled | GDPR Art. 5(1)(e) · ISO A.18 | `WEAVORY_DATA_DIR` is the single location for all persistent files. No network egress, no external services. | `src/cli.ts`, `docs/DEPLOYMENT.md` |
| Tamper detection on restart | SOC2 CC7.2 | Chain is re-verified on rehydrate; broken → exit(3). | `src/cli.ts` |
| Graceful degradation when native deps unavailable | SOC2 CC7.4 · ISO A.17 | DuckDB load failure (missing binary, ABI mismatch) transparently falls back to JSONL with a single stderr warning. The system stays up. | `src/store/persist.ts` |

### Configurable attack surface

| Control | Framework ref | How weavory implements it | Source |
|---------|---------------|---------------------------|--------|
| Public API is a fixed, documented surface | SOC2 CC6.1 · EU AI Act Art. 15 | Exactly five MCP tools (`believe`, `recall`, `subscribe`, `attest`, `forget`). Locked by ADR-005; verified by `gate2.sh` on every CI run. | `src/mcp/server.ts`, `control/DECISIONS.md` (ADR-005) |
| No HTTP ingress by default | SOC2 CC6.6 | Transport is stdio; MCP clients connect via spawn. No listening port unless explicitly deployed behind a transport adapter (not shipped). | `src/mcp/server.ts` |
| No telemetry egress | GDPR Art. 30 | No outbound HTTP from the substrate. Runtime snapshots are local-file only (`ops/data/runtime.json`). | `src/engine/runtime_writer.ts` |

---

## Explicit scope boundaries (what weavory does **not** do)

- **No authorization service.** Weavory attributes and gates by trust; it does
  not replace an IAM/RBAC layer. Deploying organizations remain responsible
  for who is allowed to spawn or configure the server.
- **No encryption at rest.** JSONL and DuckDB files are written in
  plaintext. If your threat model requires encrypted storage, use a
  filesystem-layer solution (LUKS, EFS/KMS, etc.) on `WEAVORY_DATA_DIR`.
- **No field-level PII classification / redaction.** The policy hook lets
  you *block* known-sensitive predicates or subjects; it does not inspect
  `object` content beyond size. PII-aware transformation belongs in the
  calling agent.
- **No built-in identity federation / SSO.** Signer identity is by
  Ed25519 key; mapping those keys to organizational identities is
  external.
- **No multi-tenant isolation.** One weavory process owns one
  `WEAVORY_DATA_DIR`. Tenant separation should be done at the process
  or filesystem level.

All five are tracked in `control/BACKLOG.json` with honest status and
are deliberately **out of scope** for v0.1.x and tracked on the roadmap.

---

## Verification evidence

Every control in the mapping above is reproducible by the operator:

| Evidence | How to reproduce |
|----------|------------------|
| Signed beliefs | `pnpm exec tsx examples/two_agents_collaborate.ts` prints a belief id + independent verification |
| Hash-chain tamper detection | `pnpm exec tsx examples/tamper_detection.ts` (tampers an entry, alarm fires, incident file is exported) |
| Bi-temporal recall | `pnpm exec tsx examples/temporal_rewind.ts` (forget + `as_of` replay) |
| Trust gating / adversarial mode | `pnpm exec tsx examples/adversarial_filtering.ts` |
| Policy denial | Start server with `WEAVORY_POLICY_FILE=<path>` and call `weavory.believe` with a blocked subject / predicate — server returns a structured `policy denial` error |
| Persistence round-trip | Start with `WEAVORY_PERSIST=1 WEAVORY_DATA_DIR=/tmp/w`; write a belief; restart the server; recall returns the same belief id |
| DuckDB fallback to JSONL | Remove `@duckdb/node-api` (`pnpm remove @duckdb/node-api`) and start with `WEAVORY_STORE=duckdb`; stderr warns once and JSONL is used |

All 12 machine-verifiable gate scripts in `scripts/verify/` record real
outcomes in `ops/data/gates.json` with commit hashes — that is the
canonical audit trail.

---

*Last reviewed: 2026-04-22 against HEAD of main.*
