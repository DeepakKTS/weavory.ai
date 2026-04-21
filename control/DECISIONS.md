# weavory.ai — Decision Log (ADRs)

ADR-style decisions. Each entry: date · decision · rationale · alternatives.

---

## 2026-04-21 · ADR-001 · Project name: weavory.ai

**Decision:** Project is named **weavory.ai**. Package scope `@weavory/mcp`. Binary: `weavory`.

**Rationale:** Previous working name ("Loom") had potential trademark conflict with an established video tool. "weavory.ai" evokes the weaving of agent beliefs into shared fabric and is more distinctive.

**Alternatives considered:** Loom (rejected: clash), Mnemos (rejected: overused in memory projects), Koine, Plexus (held as fallback for npm-scope conflict).

---

## 2026-04-21 · ADR-002 · Language & runtime: TypeScript on Node 20+

**Decision:** TypeScript with `"strict": true`, ESM modules, Node 20+.

**Rationale:** Best-in-class official MCP SDK; single language across server and dashboard; `npx @weavory/mcp` gives judge-friendly zero-install. Python adds env-setup friction for the fresh-machine judge test; Rust/Go a core adds build complexity we cannot afford pre-Gate 7.

**Alternatives considered:** Python core + TS dashboard (rejected: double complexity), Rust/Go core + TS shim (rejected: scope).

---

## 2026-04-21 · ADR-003 · Storage: LanceDB (vector + columnar) + DuckDB (bi-temporal SQL)

**Decision:** Embedded LanceDB for vector + columnar beliefs; embedded DuckDB for bi-temporal analytical SQL. No external services.

**Rationale:** Single-binary-friendly, zero-daemon operation is critical for the fresh-machine judge test. LanceDB provides sub-millisecond vector similarity; DuckDB natively supports temporal types required for `as_of` recall.

**Alternatives considered:** Postgres + pgvector (rejected: daemon + install overhead), SQLite + FAISS (rejected: no temporal types), Qdrant (rejected: external service).

---

## 2026-04-21 · ADR-004 · Crypto: Ed25519 signing + BLAKE3 hash chain

**Decision:** `@noble/ed25519` for signer key pairs; `@noble/hashes` (BLAKE3) for the append-only audit chain.

**Rationale:** Audited, pure-JS, no native bindings. BLAKE3 is faster than SHA-256 and well-suited to a hash chain. Ed25519 is the NANDA-compatible default.

**Alternatives considered:** secp256k1 (rejected: unnecessary web3 assumption), SHA-256 chain (rejected: slower).

---

## 2026-04-21 · ADR-005 · Public API surface locked to five tools

**Decision:** Exactly five MCP tools — `believe`, `recall`, `subscribe`, `attest`, `forget`. No additions without user approval.

**Rationale:** Simplicity is 20% of the hackathon judging weight. A tiny surface area is a moat, not a limitation. Beliefs are the only object; all other functionality (time travel, trust, merge) are parameters on `recall` or internal.

**Alternatives considered:** Separate tools for trust queries, merge operations, subscriptions (rejected: surface bloat).

---

## 2026-04-21 · ADR-006 · NANDA AgentFacts-native schema from week 1

**Decision:** `src/core/belief.ts` implements a superset of NANDA AgentFacts. `docs/NANDA.md` documents the mapping. CRDT update protocol matches NANDA's spec.

**Rationale:** NandaHack is hosted by Project NANDA. Being NANDA-native is the highest-leverage narrative for judging Impact (40%).

**Alternatives considered:** Independent schema with reference NANDA in pitch (rejected: weaker narrative).

---

## 2026-04-21 · ADR-007 · Gate-driven build order

**Decision:** Phase A → G, with each phase exiting on a machine-verifiable gate. Phase G (merge variants, replay UI, federation, arena extensions) is locked behind Gate 7.

**Rationale:** User's explicit "do not overbuild" rule. Phase-1 judge test is the real hackathon win condition.

**Alternatives considered:** Parallel Phase 2 work during Phase 1 (rejected: risks core failure).
