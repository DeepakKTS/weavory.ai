#!/usr/bin/env bash
# Gate 4 — Trust & quarantine (adversarial)
# Pass iff: examples/adversarial_filtering.ts exits 0 AND the expected honest-
# answer line is produced AND the attacker's belief is excluded from default
# recall but observable at min_trust=-1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate 4 — Trust & quarantine (repo: $REPO_ROOT)"

LOG=$(mktemp -t weavory-gate4.XXXXXX)
trap 'rm -f "$LOG"' EXIT

echo "[1/4] Running examples/adversarial_filtering.ts"
if ! pnpm exec tsx examples/adversarial_filtering.ts >"$LOG" 2>&1; then
  tail -40 "$LOG"
  bad "adversarial demo exited non-zero (trust gate did not hold)"
fi
ok "demo exit 0"

echo
echo "[2/4] alice and mallet both published"
grep -q '^\[tamper\] alice believed' "$LOG"  || bad "alice did not publish"
grep -q '^\[tamper\] mallet believed' "$LOG" || bad "mallet did not publish"
ok "both honest and attacker signed beliefs"

echo
echo "[3/4] Charlie's default recall excluded the attacker"
DEFAULT=$(sed -En 's/^\[tamper\] charlie default recall: ([0-9]+) match.*/\1/p' "$LOG")
AUDIT=$(sed -En 's/^\[tamper\] charlie audit recall \(min_trust=-1\): ([0-9]+) match.*/\1/p' "$LOG")
if [[ "$DEFAULT" != "1" ]]; then bad "default recall should return exactly 1 belief (got $DEFAULT)"; fi
if [[ "$AUDIT" != "2" ]]; then bad "audit recall should return 2 beliefs (got $AUDIT)"; fi
ok "default=1 (honest only), audit=2 (both)"

echo
echo "[4/4] Scripted answer reflects the honest reading"
grep -qF "charlie's answer: traffic in cambridge is congested (+14 min)" "$LOG" \
  || { tail -10 "$LOG"; bad "charlie's answer should be the honest reading"; }
ok "answer line matches honest reading"

echo
echo -e "\033[32mGate 4: PASS\033[0m"
