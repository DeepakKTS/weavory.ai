#!/usr/bin/env bash
# Gate Swarm — Phase G.2 phase verification
# Pass iff examples/swarm_consensus.ts exits 0 AND the four scripted output
# lines match verbatim: queue drain with delivered=3, 1 conflict group,
# consensus winner.X=42, lww winner.X=0.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate Swarm — Phase G.2 subscription queue + conflict merge"

LOG=$(mktemp -t weavory-swarm.XXXXXX)
trap 'rm -f "$LOG"' EXIT

echo "[1/5] Running examples/swarm_consensus.ts"
if ! pnpm exec tsx examples/swarm_consensus.ts >"$LOG" 2>&1; then
  tail -30 "$LOG"
  bad "swarm_consensus exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/5] Subscription queue drained 3 beliefs"
grep -qE '^\[swarm\] subscription drain: delivered=3 dropped=0' "$LOG" \
  || { tail -20 "$LOG"; bad "expected 'delivered=3 dropped=0'"; }
ok "delivered=3 dropped=0"

echo
echo "[3/5] include_conflicts surfaced exactly 1 group with 3 variants"
grep -qF 'include_conflicts=true: 1 group with 3 variants' "$LOG" \
  || { tail -20 "$LOG"; bad "expected 1 conflict group with 3 variants"; }
ok "1 conflict group · 3 variants"

echo
echo "[4/5] consensus merge picked X=42 (trust-weighted)"
grep -qF 'merge_strategy=consensus → winner.X = 42' "$LOG" \
  || { tail -20 "$LOG"; bad "expected consensus winner.X=42"; }
ok "consensus winner.X = 42"

echo
echo "[5/5] lww merge picked X=0 (latest recorded_at)"
grep -qF 'merge_strategy=lww → winner.X = 0' "$LOG" \
  || { tail -20 "$LOG"; bad "expected lww winner.X=0"; }
ok "lww winner.X = 0"

echo
echo -e "\033[32mGate Swarm: PASS\033[0m"
