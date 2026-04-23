#!/usr/bin/env bash
# Gate Temporal — Phase G.4 phase verification
# Pass iff:
#   1) examples/branch_snapshots.ts exits 0 with the three scripted AAPL
#      value lines (main: [100,110], branch: [100,90], as_of=T0: [100]).
#   2) The demo exports an incident file.
#   3) `weavory replay --from <that incident>` rehydrates it and surfaces
#      both AAPL=100 and AAPL=110 with a matched count ≥ 2.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate Temporal — Phase G.4 branch snapshot + replay CLI"

LOG=$(mktemp -t weavory-temporal.XXXXXX)
CLI_LOG=$(mktemp -t weavory-temporal-cli.XXXXXX)
trap 'rm -f "$LOG" "$CLI_LOG"' EXIT

echo "[1/6] Running examples/branch_snapshots.ts"
if ! pnpm exec tsx examples/branch_snapshots.ts >"$LOG" 2>&1; then
  tail -30 "$LOG"
  bad "branch_snapshots demo exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/6] main live AAPL values = [100,110]"
grep -qF 'main live AAPL values: [100,110]' "$LOG" \
  || { tail -20 "$LOG"; bad "expected main live [100,110]"; }
ok "main live = [100,110]"

echo
echo "[3/6] branch live AAPL values = [100,90]"
# JS default .sort() sorts as strings → "100" < "90" lexicographically,
# so the array renders as [100,90], not [90,100]. We pin the literal.
grep -qF 'branch live AAPL values: [100,90]' "$LOG" \
  || { tail -20 "$LOG"; bad "expected branch live [100,90]"; }
ok "branch live = [100,90]"

echo
echo "[4/6] main as_of=T0 AAPL values = [100]"
grep -qF 'main as_of=T0 AAPL values: [100]' "$LOG" \
  || { tail -20 "$LOG"; bad "expected as_of=T0 AAPL [100]"; }
ok "main as_of=T0 = [100]"

echo
echo "[5/6] Demo exported an incident file"
INCIDENT=$(sed -En 's/^\[temporal\] incident_path=(.+)$/\1/p' "$LOG" | tail -1)
if [[ -z "$INCIDENT" || ! -s "$INCIDENT" ]]; then
  bad "incident_path missing or file empty (got: '$INCIDENT')"
fi
ok "incident file: $(basename "$INCIDENT")"

echo
echo "[6/6] weavory replay CLI against the incident surfaces AAPL=100 and AAPL=110"
if ! pnpm exec tsx src/cli.ts replay --from "$INCIDENT" --query AAPL --top-k 10 >"$CLI_LOG" 2>&1; then
  tail -20 "$CLI_LOG"
  bad "weavory replay exited non-zero"
fi
# Expect a matched count of 2 and both AAPL numbers to appear.
grep -qE '^\[replay\] matched=[23]' "$CLI_LOG" \
  || { tail -20 "$CLI_LOG"; bad "replay matched count should be 2 or 3"; }
grep -qF 'stock:AAPL / price = 100' "$CLI_LOG" \
  || { tail -20 "$CLI_LOG"; bad "replay should print stock:AAPL / price = 100"; }
grep -qF 'stock:AAPL / price = 110' "$CLI_LOG" \
  || { tail -20 "$CLI_LOG"; bad "replay should print stock:AAPL / price = 110"; }
ok "replay CLI shows AAPL=100 and AAPL=110"

echo
echo -e "\033[32mGate Temporal: PASS\033[0m"
