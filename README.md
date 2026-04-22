# weavory

**Shared belief coordination substrate for AI agents.**
An MCP server with signed beliefs, trust-gated recall, hash-chained audit, and bi-temporal replay — in five tools.

[![npm](https://img.shields.io/npm/v/@weavory/mcp.svg)](https://www.npmjs.com/package/@weavory/mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-197%2F197-brightgreen.svg)](#status)
[![ci](https://img.shields.io/badge/ci-passing-brightgreen.svg)](./.github/workflows)

When multiple AI agents share memory, every claim needs a signer, a
timestamp, and a way to be revoked — or the whole pipeline is
untrustworthy. weavory gives you that, as an MCP-native server your
agents can spawn with one command.

---

## Install

```bash
# npx — zero install, no build
npx -y @weavory/mcp start

# Docker — multi-arch (linux/amd64, linux/arm64)
docker run -v weavory-data:/data ghcr.io/deepakkts/weavory:latest

# From source
git clone https://github.com/DeepakKTS/weavory.ai.git
cd weavory.ai && pnpm install && pnpm build
```

The server speaks MCP over stdio. Point Claude Desktop, Cursor, any
MCP-capable agent, or the official MCP SDKs at it. See
[`docs/INSTALL.md`](./docs/INSTALL.md) for the Claude Desktop config
snippet.

---

## The five tools

| Tool | What it does |
|------|--------------|
| `weavory.believe` | Sign a claim (Ed25519), content-address it (BLAKE3), store it, append to the audit chain, fan out to matching subscribers. |
| `weavory.recall` | Retrieve beliefs with trust gating, bi-temporal `as_of`, quarantine filter, and subject / predicate / confidence filters. |
| `weavory.subscribe` | Register a bounded queue keyed on a pattern + filters. Drain via `recall`. |
| `weavory.attest` | Update `trust(signer, topic)` in `[-1, 1]`. |
| `weavory.forget` | Tombstone a belief — `invalidated_at` set, history preserved for `as_of` queries. |

This is the complete public API. No magic, no hidden surface.

---

## 60-second example

Four agents triage a $42,000 insurance claim: intake → fraud →
underwriting → approver. An unknown signer tries to inject a forged
approval. Under `WEAVORY_ADVERSARIAL=1`, weavory's default trust floor
(0.6) quarantines the forgery automatically. The honest chain
completes. An incident JSON is exported for forensic replay.

```bash
pnpm exec tsx examples/bfsi_claims_triage.ts
```

Self-asserts: the attacker's belief is **never visible** in the
approver's default recall, but **is visible** in the compliance audit
view (`min_trust: -1`). Audit chain verifies `ok` at the end.

Full walkthrough in [`docs/REAL_WORLD_USAGE.md`](./docs/REAL_WORLD_USAGE.md).

---

## What you get

- **Ed25519-signed beliefs** — every claim is cryptographically attributable to a signer.
- **BLAKE3 hash-chained audit log** — retroactive edits break the chain; tamper is detected.
- **Trust-gated recall** — unknown signers default to neutral (0.5); raise the floor to 0.6 for adversarial deployments.
- **Bi-temporal replay** — `recall({ as_of: "<ISO>" })` reconstructs the world as it was at any past instant.
- **Dual persistence** — JSONL (default, zero native deps, synchronously durable) or DuckDB (opt-in, WAL-backed) with graceful binary fallback.
- **Pre-ingest policy hook** — `WEAVORY_POLICY_FILE=<json>` for allow / deny rules on subjects (glob), predicates (exact), payload size.
- **Incident export + replay** — `exportIncident()` snapshots state; `weavory replay --from <path>` rehydrates off-process for review.
- **Honest scope** — G-Set beliefs + LWW tombstones + optional consensus merge. Not a full state-merging CRDT; we don't overclaim.

---

## Documentation

| Doc | What's inside |
|-----|---------------|
| [`docs/README.md`](./docs/README.md) | 60-second quickstart |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | One-page system model |
| [`docs/REAL_WORLD_USAGE.md`](./docs/REAL_WORLD_USAGE.md) | Enterprise integration patterns + the BFSI scenario |
| [`docs/INSTALL.md`](./docs/INSTALL.md) | Three install paths, Claude Desktop config |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | Env-var reference, persistence modes, Compose |
| [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) | Operational scenarios — restart, policy denial, incident replay, key rotation |
| [`docs/COMPLIANCE.md`](./docs/COMPLIANCE.md) | SOC2 / ISO27001 / GDPR / EU AI Act / NIST AI-RMF mapping |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Protected · mitigated · deferred |

---

## Status

- **197/197** automated tests — unit + integration + performance
- **CI green** on Ubuntu + macOS with Node 22 LTS
- **Strict TypeScript** — no `any` in `src/`
- Published to [npm](https://www.npmjs.com/package/@weavory/mcp) and [GitHub Container Registry](https://github.com/DeepakKTS/weavory.ai/pkgs/container/weavory) on every release tag
- Time-to-first-belief from fresh `npx -y @weavory/mcp start`: under 30 seconds

---

## What weavory is not (deliberate scope)

- Not a generic memory-as-a-service — run one weavory per trust boundary.
- Not a vector database — substring recall today.
- Not federated — single writer per data directory.
- Not multi-tenant — isolation is filesystem / process level.
- Not encrypted at rest — use filesystem-layer encryption (LUKS, EFS/KMS).
- Not an identity provider — signer IDs are public keys; SSO mapping is external.

Each is a documented boundary, not a hidden gap.

---

## Contributing

Issues and PRs welcome. Please read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) before proposing core changes; the public API (five MCP tools) is locked and any new surface requires a design discussion.

Run the full test suite before submitting:

```bash
pnpm install && pnpm test && pnpm lint
```

---

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

Copyright © 2026 DeepakKTS.

---

<sub>Built for [NandaHack 2026](https://projectnanda.org) @ MIT Media Lab.</sub>
