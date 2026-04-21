#!/usr/bin/env bash
# Gate 5 — as_of recall (bi-temporal)
# Pass iff: examples/gauntlet_rewind.ts exits 0 AND live recall == 0 AND
# past recall (as_of=pre-forget snapshot) == 1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate 5 — as_of recall (repo: $REPO_ROOT)"

LOG=$(mktemp -t weavory-gate5.XXXXXX)
trap 'rm -f "$LOG"' EXIT

echo "[1/3] Running examples/gauntlet_rewind.ts"
if ! pnpm exec tsx examples/gauntlet_rewind.ts >"$LOG" 2>&1; then
  tail -30 "$LOG"
  bad "rewind demo exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/3] Live recall is empty after forget"
LIVE=$(sed -En 's/^\[rewind\] live recall: ([0-9]+) match.*/\1/p' "$LOG")
if [[ "$LIVE" != "0" ]]; then bad "live recall must be 0 (got: '$LIVE')"; fi
ok "live recall == 0 (tombstone respected)"

echo
echo "[3/3] Past recall (as_of pre-forget) is non-empty"
PAST=$(sed -En 's/^\[rewind\] past recall \(as_of=[^)]+\): ([0-9]+) match.*/\1/p' "$LOG")
if [[ "$PAST" != "1" ]]; then bad "past recall must be 1 (got: '$PAST')"; fi
ok "past recall == 1 (bi-temporal state preserved)"

echo
echo -e "\033[32mGate 5: PASS\033[0m"
