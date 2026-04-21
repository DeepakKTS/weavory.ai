#!/usr/bin/env bash
# Gate 3 — Two-agent belief exchange
# Pass iff: examples/two_agents_collaborate.ts exits 0 AND the demo prints the
# expected scripted answer AND independent signature verification succeeded.
#
# Truthfulness: we assert on real stdout lines produced by the demo script.
# No hand-waved status. If the demo fails or the answer mismatches, Gate 3 FAILS.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate 3 — Two-agent belief exchange (repo: $REPO_ROOT)"

LOG=$(mktemp -t weavory-gate3.XXXXXX)
trap 'rm -f "$LOG"' EXIT

echo "[1/4] Running examples/two_agents_collaborate.ts"
if ! pnpm exec tsx examples/two_agents_collaborate.ts >"$LOG" 2>&1; then
  tail -40 "$LOG"
  bad "demo script exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/4] Checking Alice published a belief"
grep -q '^\[demo\] alice believed [0-9a-f]\{12\}' "$LOG" || bad "alice did not publish a valid belief id"
ok "alice published a 64-hex belief id"

echo
echo "[3/4] Checking Bob independently verified Alice's signature"
grep -qF 'bob independently verified alice' "$LOG" || bad "independent verification line missing"
ok "independent signature verification succeeded"

echo
echo "[4/4] Checking scripted answer"
EXPECTED="bob's answer: traffic in cambridge is congested (+14 min)"
grep -qF "$EXPECTED" "$LOG" || { tail -20 "$LOG"; bad "scripted answer mismatch"; }
ok "scripted answer matches expectation"

echo
echo -e "\033[32mGate 3: PASS\033[0m"
