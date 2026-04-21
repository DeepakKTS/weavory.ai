#!/usr/bin/env bash
# Gate Wall — Phase G.3 arena verification
# Pass iff wall_incident.ts exits 0 AND its scripted log lines appear AND
# a new incident file lands on disk AND that incident file's verify.ok
# is false with bad_index=1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate Wall — Phase G.3 adversarial drill"

LOG=$(mktemp -t weavory-wall.XXXXXX)
trap 'rm -f "$LOG"' EXIT

# Snapshot incident count before running.
BEFORE=$(ls ops/data/incidents 2>/dev/null | grep -c '^incident-' || true)

echo "[1/5] Running examples/wall_incident.ts"
if ! pnpm exec tsx examples/wall_incident.ts >"$LOG" 2>&1; then
  tail -30 "$LOG"
  bad "wall_incident exited non-zero"
fi
ok "demo exit 0"

echo
echo "[2/5] Pre-tamper scan reported ok; post-tamper alarm fired"
grep -qF '[wall] pre-tamper scan: ok' "$LOG" \
  || { tail -20 "$LOG"; bad "pre-tamper 'ok' log line missing"; }
grep -qE '^\[wall\] post-tamper scan: bad_index=1 reason=entry_hash' "$LOG" \
  || { tail -20 "$LOG"; bad "post-tamper 'bad_index=1 reason=entry_hash' log line missing"; }
ok "pre:ok, post:bad_index=1 reason=entry_hash"

echo
echo "[3/5] runtime.json.tamper_alarm surfaced"
grep -qF 'runtime.json.tamper_alarm surfaced to dashboard' "$LOG" \
  || { tail -20 "$LOG"; bad "runtime.json surfacing log line missing"; }
ok "tamper alarm hit runtime.json"

echo
echo "[4/5] A new incident file exists under ops/data/incidents/"
AFTER=$(ls ops/data/incidents 2>/dev/null | grep -c '^incident-' || true)
if [[ "$AFTER" -le "$BEFORE" ]]; then
  bad "no new incident file written (before=$BEFORE, after=$AFTER)"
fi
ok "incidents: ${BEFORE} → ${AFTER}"

echo
echo "[5/5] Latest incident file records verify.ok=false with bad_index=1"
LATEST=$(ls -t ops/data/incidents/incident-*.json 2>/dev/null | head -1)
[[ -n "$LATEST" ]] || bad "no incident file found"
VERIFY_OK=$(node -e "const r=require('./${LATEST}'); process.stdout.write(String(r.audit.verify.ok))")
BAD_INDEX=$(node -e "const r=require('./${LATEST}'); process.stdout.write(String(r.audit.verify.bad_index))")
if [[ "$VERIFY_OK" != "false" ]]; then bad "incident verify.ok=$VERIFY_OK (want false)"; fi
if [[ "$BAD_INDEX" != "1" ]]; then bad "incident verify.bad_index=$BAD_INDEX (want 1)"; fi
ok "$(basename "$LATEST") · verify.ok=false · bad_index=1"

echo
echo -e "\033[32mGate Wall: PASS\033[0m"
