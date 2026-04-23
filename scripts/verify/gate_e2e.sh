#!/usr/bin/env bash
# Gate E2E — Phase G.6 integration verification
# Proves all four Phase-G composite features compose against a single
# EngineState. Pass iff end_to_end_integration.ts exits 0 AND each feature's
# completion marker appears AND the final summary line reports all four
# feature flags green.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate E2E — Phase G.6 integration (Swarm + Tamper + Temporal + Escrow)"

LOG=$(mktemp -t weavory-e2e.XXXXXX)
trap 'rm -f "$LOG"' EXIT

echo "[1/7] Running examples/end_to_end_integration.ts"
if ! pnpm exec tsx examples/end_to_end_integration.ts >"$LOG" 2>&1; then
  tail -40 "$LOG"
  bad "end_to_end_integration exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/7] SWARM: drained 3 · consensus winner BTC=\$50000"
grep -qF 'bob drained subscription: delivered=3 dropped=0' "$LOG" \
  || { tail -20 "$LOG"; bad "swarm drain line missing"; }
grep -qF 'consensus winner BTC=$50000' "$LOG" \
  || { tail -20 "$LOG"; bad "swarm consensus winner line missing"; }
ok "swarm drain=3 · consensus=50000"

echo
echo "[3/7] TAMPER: adversarial recall keeps alice, filters mallet"
grep -qF 'default recall (adversarial): alice_visible=true mallet_visible=false' "$LOG" \
  || { tail -20 "$LOG"; bad "tamper trust-gate line missing"; }
grep -qE '^\[e2e\] tamper scan: ok' "$LOG" \
  || { tail -20 "$LOG"; bad "tamper scan-ok line missing"; }
ok "trust gate filters mallet · tamper scan clean"

echo
echo "[4/7] TEMPORAL: main and branch diverge"
grep -qF 'main BTC prices: [50000,60000] · branch BTC prices: [30000,50000]' "$LOG" \
  || { tail -20 "$LOG"; bad "temporal divergence line missing"; }
grep -qE '^\[e2e\] incident_path=.*/ops/data/incidents/incident-' "$LOG" \
  || { tail -20 "$LOG"; bad "temporal incident_path missing"; }
ok "temporal main=[50000,60000] · branch=[30000,50000] · incident exported"

echo
echo "[5/7] ESCROW: four-stage escrow settled accepted"
grep -qF 'escrow thread: offer,payment,delivered,settled' "$LOG" \
  || { tail -20 "$LOG"; bad "escrow 4-stage thread line missing"; }
grep -qF 'isEscrowSettled=true outcome=accepted' "$LOG" \
  || { tail -20 "$LOG"; bad "escrow settled-accepted line missing"; }
ok "escrow stages correct · isEscrowSettled=true · outcome=accepted"

echo
echo "[6/7] Audit chain still clean after all four composite features"
grep -qE '^\[e2e\] final chain length=[0-9]+ · verify=ok' "$LOG" \
  || { tail -20 "$LOG"; bad "final chain-verify line missing"; }
ok "final chain verify=ok"

echo
echo "[7/7] Final integration summary reports all four composite features green"
grep -qF '✓ Gate E2E integration passed · swarm=3 tamper=true temporal=true escrow=true' "$LOG" \
  || { tail -20 "$LOG"; bad "final integration summary missing or flags not all true"; }
ok "swarm=3 · tamper=true · temporal=true · escrow=true"

echo
echo -e "\033[32mGate E2E: PASS\033[0m"
