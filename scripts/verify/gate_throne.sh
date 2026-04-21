#!/usr/bin/env bash
# Gate Throne — Phase G.6 integration verification
# Proves all four Phase-G arena features compose against a single
# EngineState. Pass iff throne_integration.ts exits 0 AND each arena's
# completion marker appears AND the final summary line reports all four
# arena flags green.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate Throne — Phase G.6 integration (Commons + Wall + Gauntlet + Bazaar)"

LOG=$(mktemp -t weavory-throne.XXXXXX)
trap 'rm -f "$LOG"' EXIT

echo "[1/7] Running examples/throne_integration.ts"
if ! pnpm exec tsx examples/throne_integration.ts >"$LOG" 2>&1; then
  tail -40 "$LOG"
  bad "throne_integration exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/7] COMMONS: drained 3 · consensus winner BTC=\$50000"
grep -qF 'bob drained subscription: delivered=3 dropped=0' "$LOG" \
  || { tail -20 "$LOG"; bad "commons drain line missing"; }
grep -qF 'consensus winner BTC=$50000' "$LOG" \
  || { tail -20 "$LOG"; bad "commons consensus winner line missing"; }
ok "commons drain=3 · consensus=50000"

echo
echo "[3/7] WALL: adversarial recall keeps alice, filters mallet"
grep -qF 'default recall (adversarial): alice_visible=true mallet_visible=false' "$LOG" \
  || { tail -20 "$LOG"; bad "wall trust-gate line missing"; }
grep -qE '^\[throne\] tamper scan: ok' "$LOG" \
  || { tail -20 "$LOG"; bad "wall tamper-ok line missing"; }
ok "wall trust gate filters mallet · tamper scan clean"

echo
echo "[4/7] GAUNTLET: main and branch diverge"
grep -qF 'main BTC prices: [50000,60000] · branch BTC prices: [30000,50000]' "$LOG" \
  || { tail -20 "$LOG"; bad "gauntlet divergence line missing"; }
grep -qE '^\[throne\] incident_path=.*/ops/data/incidents/incident-' "$LOG" \
  || { tail -20 "$LOG"; bad "gauntlet incident_path missing"; }
ok "gauntlet main=[50000,60000] · branch=[30000,50000] · incident exported"

echo
echo "[5/7] BAZAAR: four-stage escrow settled accepted"
grep -qF 'escrow thread: offer,payment,delivered,settled' "$LOG" \
  || { tail -20 "$LOG"; bad "bazaar 4-stage thread line missing"; }
grep -qF 'isEscrowSettled=true outcome=accepted' "$LOG" \
  || { tail -20 "$LOG"; bad "bazaar settled-accepted line missing"; }
ok "bazaar stages correct · isEscrowSettled=true · outcome=accepted"

echo
echo "[6/7] Audit chain still clean after all four arenas"
grep -qE '^\[throne\] final chain length=[0-9]+ · verify=ok' "$LOG" \
  || { tail -20 "$LOG"; bad "final chain-verify line missing"; }
ok "final chain verify=ok"

echo
echo "[7/7] Final integration summary reports all four arenas green"
grep -qF '✓ Gate Throne integration passed · commons=3 wall=true gauntlet=true bazaar=true' "$LOG" \
  || { tail -20 "$LOG"; bad "final integration summary missing or flags not all true"; }
ok "commons=3 · wall=true · gauntlet=true · bazaar=true"

echo
echo -e "\033[32mGate Throne: PASS\033[0m"
