# weavory.ai — Install

Three documented install paths. Pick the one that matches your context.

| Path | Audience | Time | Prereqs |
|------|---------|------|---------|
| [1. Source (judge + dev)](#1-from-source) | Hackathon judges, developers | ~90 s | Node ≥ 20, pnpm ≥ 9, git |
| [2. Claude Desktop MCP client](#2-claude-desktop--other-mcp-client) | Local dev with an agent | ~2 min | Path 1 complete, Claude Desktop |
| [3. Docker](#3-docker--compose) | Operators, container-native deployments | ~3 min | Docker ≥ 24 |

> **About Node/pnpm versions.** The CI matrix (`.github/workflows/fresh-machine.yml`)
> runs Node 22 LTS on Ubuntu + macOS. Node 20 works too. pnpm 9 or 10 both work.

---

## 1. From source

```bash
git clone https://github.com/DeepakKTS/weavory.ai.git
cd weavory.ai
pnpm install            # includes optional @duckdb/node-api (see §DuckDB note)
pnpm build              # tsc → dist/
pnpm exec tsx examples/two_agents_collaborate.ts     # sanity check (Gate 3)
```

Expected output from the sanity check ends with:

```
[demo] ✓ Gate 3 demo complete — two-agent exchange via weavory round-tripped cleanly.
```

If you only see "pnpm install" errors, the usual cause is a stale pnpm
cache after a Node upgrade — `pnpm store prune` and retry.

### DuckDB note (optional backend)

`@duckdb/node-api` is listed as an **optional** dependency. If your
platform has no prebuilt addon, `pnpm install` emits a warning and
continues — the JSONL persistence backend (and in-memory default) still
work. No code changes needed. See
[DEPLOYMENT.md § Persistence](./DEPLOYMENT.md#persistence).

---

## 2. Claude Desktop / other MCP client

After path 1 is complete, point your MCP-capable agent at the built CLI.

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "weavory": {
      "command": "node",
      "args": ["/absolute/path/to/weavory.ai/dist/cli.js", "start"],
      "env": {
        "WEAVORY_PERSIST": "1",
        "WEAVORY_DATA_DIR": "/Users/you/.weavory-data",
        "WEAVORY_ADVERSARIAL": "0"
      }
    }
  }
}
```

Restart Claude Desktop. In a new conversation, ask the agent to "list
your tools" — you should see `weavory.believe`, `weavory.recall`,
`weavory.subscribe`, `weavory.attest`, `weavory.forget`.

### Cursor / OpenClaw / other stdio-MCP clients

Point them at the same `node dist/cli.js start` command. Env vars
propagate the same way. stdio is the only transport weavory ships —
HTTP transport is on the post-hackathon backlog (B-0007).

---

## 3. Docker / Compose

```bash
docker compose up --build
```

This builds a multi-stage image (node:22-slim runtime) and mounts a
persistent volume at `/data`. Defaults to **JSONL persistence** and
**adversarial mode off**. See [DEPLOYMENT.md § Docker](./DEPLOYMENT.md#docker)
for the production-style profile.

Container quick check:

```bash
# In one terminal
docker compose logs -f weavory

# In another — attach an MCP client to the running container's stdio
docker compose exec weavory node dist/cli.js --help
```

> Note: MCP over stdio + Docker containers is an unusual combo. For
> a pure MCP-client workflow, prefer path 1 or 2. Docker is included
> for operators who want a reproducible deployment story (e.g. behind
> a separate HTTP transport built in-house).

---

## Verifying your install

Run any one of these:

```bash
pnpm verify:gate3     # two-agent belief exchange
pnpm verify:gate4     # trust / quarantine
pnpm verify:gate5     # bi-temporal recall
pnpm bench            # throughput smoke bench
pnpm test             # full Vitest suite (178 tests)
```

All four must pass on a healthy install. If any fails, see
[RUNBOOK.md § Install failures](./RUNBOOK.md#install--first-run-failures).
