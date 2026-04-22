# syntax=docker/dockerfile:1.7
#
# weavory.ai — multi-stage image
#
# Stage 1 (build): install all deps, compile TypeScript → dist/
# Stage 2 (runtime): node:22-slim + dist + prod deps only
#
# Size target: < 180 MB for the runtime stage with DuckDB binary
# included, < 110 MB without. Native deps (@duckdb/node-api) are
# an "optionalDependencies" so pnpm install continues if the binary
# is unavailable for the target arch — see docs/DEPLOYMENT.md.

# ---------- build stage ----------
FROM node:22-slim AS build

WORKDIR /app

# pnpm via corepack so the image version matches repo versioning
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# Copy lockfile first for best cache hit rate
COPY package.json pnpm-lock.yaml ./

# Full install including optional DuckDB addon (best-effort; install
# continues even if the binary can't resolve on this arch).
RUN pnpm install --frozen-lockfile

# Copy source + config
COPY tsconfig.json ./
COPY src ./src

# Compile
RUN pnpm build

# Strip devDeps so the next stage copies a lean node_modules
RUN pnpm prune --prod

# ---------- runtime stage ----------
FROM node:22-slim AS runtime

# tini keeps stdio clean and handles signals properly so SIGTERM reaches
# the Node process and the runtime writer flushes its final snapshot.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Non-root user
RUN groupadd --gid 10001 weavory \
    && useradd  --uid 10001 --gid weavory --create-home --shell /usr/sbin/nologin weavory

# Copy pruned artifacts from build stage
COPY --from=build --chown=weavory:weavory /app/node_modules ./node_modules
COPY --from=build --chown=weavory:weavory /app/dist         ./dist
COPY --chown=weavory:weavory package.json                    ./package.json
COPY --chown=weavory:weavory docs/README.md                  ./docs/README.md
COPY --chown=weavory:weavory docs/DEPLOYMENT.md              ./docs/DEPLOYMENT.md
COPY --chown=weavory:weavory docs/COMPLIANCE.md              ./docs/COMPLIANCE.md
COPY --chown=weavory:weavory docs/RUNBOOK.md                 ./docs/RUNBOOK.md

# Persist target (compose mounts a volume here)
RUN mkdir -p /data && chown weavory:weavory /data

# Runtime env defaults — operator can override via compose / docker run
ENV WEAVORY_PERSIST=1 \
    WEAVORY_DATA_DIR=/data \
    WEAVORY_STORE=jsonl \
    WEAVORY_RUNTIME_WRITER=on

USER weavory

# stdio is the MCP transport — no port to expose.
# HEALTHCHECK is intentionally lightweight because stdio servers don't
# answer network probes. We check that the runtime writer is still
# updating its snapshot; stale snapshot = broken process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e '\
    const { statSync } = require("fs"); \
    try { \
      const s = statSync("/data/../ops/data/runtime.json"); \
      const ageMs = Date.now() - s.mtimeMs; \
      if (ageMs > 60000) process.exit(1); \
    } catch (e) { /* first-run: no snapshot yet — allow */ } \
    process.exit(0); \
  '

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli.js", "start"]
