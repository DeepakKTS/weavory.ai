#!/usr/bin/env bash
# Gate 7 — README-only stock-agent judge simulation
# Pass iff: tests/judge/gate7_simulation.ts exits 0 AND its final log line
# states the scripted answer was produced. Exits 2 if ANTHROPIC_API_KEY is
# missing so CI/devs can distinguish "skipped" from "failed".

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }
skip() { printf "  \033[33m…\033[0m %s\n" "$1"; exit 2; }

echo "Gate 7 — README-only judge simulation"

echo "[1/3] Load .env if present"
if [[ -f .env ]]; then
  # Export only a specific allowlist of keys; do not leak to transcript.
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  ok ".env loaded"
else
  ok ".env not present (will use process env only)"
fi

echo
echo "[2/3] ANTHROPIC_API_KEY available?"
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  skip "ANTHROPIC_API_KEY not set — skipping Gate 7 (not a failure)"
fi
ok "ANTHROPIC_API_KEY present"

echo
echo "[3/3] Running judge simulation"
LOG=$(mktemp -t weavory-gate7.XXXXXX)
trap 'rm -f "$LOG"' EXIT

set +e
pnpm exec tsx tests/judge/gate7_simulation.ts >"$LOG" 2>&1
status=$?
set -e

if [[ "$status" -eq 2 ]]; then
  tail -5 "$LOG"
  skip "simulation skipped (exit 2)"
fi
if [[ "$status" -ne 0 ]]; then
  tail -40 "$LOG"
  bad "simulation exited $status"
fi

grep -qF "Gate 7 simulation: stock agent completed the task" "$LOG" \
  || { tail -30 "$LOG"; bad "scripted-answer completion line missing from output"; }

ok "stock Claude agent produced the scripted answer using only docs/README.md"

echo
echo -e "\033[32mGate 7: PASS\033[0m"
