#!/usr/bin/env bash
# Gate dashboard — Phase N.2 SSE sidecar verification.
# Shell wrapper around the TypeScript gate so rehearsal.sh can chain it.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
exec pnpm exec tsx scripts/verify/gate_dashboard.ts
