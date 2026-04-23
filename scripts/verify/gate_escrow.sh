#!/usr/bin/env bash
# Gate Escrow — Phase G.5 phase verification
# Pass iff escrow_marketplace.ts exits 0 AND the scripted log lines appear:
#   - offer discovered with the canonical name
#   - reputation avg_trust ≥ 0.85 with ≥ 2 attestations
#   - four-stage escrow thread walked: offer,payment,delivered,settled
#   - isEscrowSettled = true, outcome = accepted

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate Escrow — Phase G.5 discovery + reputation + escrow"

LOG=$(mktemp -t weavory-escrow.XXXXXX)
trap 'rm -f "$LOG"' EXIT

echo "[1/5] Running examples/escrow_marketplace.ts"
if ! pnpm exec tsx examples/escrow_marketplace.ts >"$LOG" 2>&1; then
  tail -30 "$LOG"
  bad "escrow_marketplace exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/5] Bob discovered the capability offer"
grep -qF '[escrow] bob discovered offer: name=summarize_paragraph' "$LOG" \
  || { tail -20 "$LOG"; bad "discovery line missing"; }
ok "offer discovery · name=summarize_paragraph"

echo
echo "[3/5] Reputation attached with ≥ 2 attestations"
REP_LINE=$(grep -E '^\[escrow\] bob fetched alice' "$LOG" | tail -1)
[[ -n "$REP_LINE" ]] || bad "reputation line missing"
AVG=$(sed -En 's/.*avg_trust=([0-9.]+).*/\1/p' <<<"$REP_LINE")
ATT=$(sed -En 's/.*attestations=([0-9]+).*/\1/p' <<<"$REP_LINE")
# Shell float compare via awk (portable, no bc dependency).
if awk "BEGIN{exit !($AVG+0 >= 0.85)}"; then true; else bad "avg_trust=$AVG should be ≥ 0.85"; fi
[[ "$ATT" -ge 2 ]] || bad "attestations=$ATT should be ≥ 2"
ok "reputation · avg_trust=$AVG · attestations=$ATT"

echo
echo "[4/5] Four-stage escrow thread walked in order"
grep -qF '[escrow] escrow thread stages: offer,payment,delivered,settled' "$LOG" \
  || { tail -20 "$LOG"; bad "four-stage order missing"; }
ok "stages: offer,payment,delivered,settled"

echo
echo "[5/5] isEscrowSettled = true and outcome = accepted"
grep -qF '[escrow] isEscrowSettled = true, outcome = accepted' "$LOG" \
  || { tail -20 "$LOG"; bad "settled/accepted line missing"; }
ok "settled=true · outcome=accepted"

echo
echo -e "\033[32mGate Escrow: PASS\033[0m"
