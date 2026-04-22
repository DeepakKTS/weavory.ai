#!/usr/bin/env bash
# Gate BFSI — Phase J.P1-2 · Responsible-AI claims-triage drill
# Pass iff bfsi_claims_triage.ts exits 0 AND its scripted log lines appear
# AND a new incident file lands under ops/data/incidents/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate BFSI — Phase J.P1-2 claims-triage (intake → fraud → underwriting → approver)"

LOG=$(mktemp -t weavory-bfsi.XXXXXX)
trap 'rm -f "$LOG"' EXIT

BEFORE=$(ls ops/data/incidents 2>/dev/null | grep -c '^incident-' || true)

echo "[1/5] Running examples/bfsi_claims_triage.ts"
if ! pnpm exec tsx examples/bfsi_claims_triage.ts >"$LOG" 2>&1; then
  tail -40 "$LOG"
  bad "bfsi_claims_triage exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/5] Attacker was quarantined from underwriter's default recall"
grep -qF 'attacker QUARANTINED' "$LOG" \
  || { tail -30 "$LOG"; bad "'attacker QUARANTINED' log line missing"; }
ok "underwriter recall excluded mallet"

echo
echo "[3/5] Final decision was authorized from trusted chain only"
grep -qE 'APPROVED \$42,000 \(audit_trail length=3\)' "$LOG" \
  || { tail -30 "$LOG"; bad "final_decision line with audit_trail length=3 missing"; }
ok "approver: APPROVED \$42,000 · audit_trail=3"

echo
echo "[4/5] Compliance audit view surfaced ALL beliefs including attacker"
grep -qE 'compliance view .min_trust=-1. surfaced ALL 5 beliefs' "$LOG" \
  || { tail -30 "$LOG"; bad "compliance view line missing (expected 5 beliefs incl. attacker)"; }
ok "compliance view saw 5 beliefs (intake + fraud + uw + approver + attacker)"

echo
echo "[5/5] New incident file exists and chain verifies ok"
AFTER=$(ls ops/data/incidents 2>/dev/null | grep -c '^incident-' || true)
if [[ "$AFTER" -le "$BEFORE" ]]; then
  bad "no new incident file written (before=$BEFORE, after=$AFTER)"
fi
grep -qE 'final audit chain length=[0-9]+ · verify=ok' "$LOG" \
  || { tail -30 "$LOG"; bad "final 'verify=ok' line missing"; }
ok "incidents: ${BEFORE} → ${AFTER} · chain verify=ok"

echo
echo -e "\033[32mGate BFSI: PASS\033[0m"
