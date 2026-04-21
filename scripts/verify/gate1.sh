#!/usr/bin/env bash
# Gate 1 — Bootstrap
# Pass iff: all control files exist, dashboard exists, git collector produces ops/data/git.json.
#
# Truthfulness contract: this script checks file presence and collector output only.
# It does NOT create or backfill any files. A failing gate must stay red until real work makes it green.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

fail=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=1; }

echo "Gate 1 — Bootstrap (repo: $REPO_ROOT)"

# 1. Control files must exist.
echo
echo "[1/4] Control files"
for f in \
  control/MASTER_PLAN.md \
  control/DECISIONS.md \
  control/TASKS.json \
  control/STATUS.json \
  control/RISKS.json \
  control/BACKLOG.json \
  control/WORKLOG.md \
  control/TEST_MATRIX.md \
  control/JUDGE_GATES.md
do
  if [[ -f "$f" ]]; then ok "$f"; else bad "$f missing"; fi
done

# 2. Dashboard.
echo
echo "[2/4] Dashboard"
if [[ -f "ops/weavory-dashboard.html" ]]; then ok "ops/weavory-dashboard.html"; else bad "ops/weavory-dashboard.html missing"; fi

# 3. package.json + tsconfig.
echo
echo "[3/4] Node project"
if [[ -f "package.json" ]]; then ok "package.json"; else bad "package.json missing"; fi
if [[ -f "tsconfig.json" ]]; then ok "tsconfig.json"; else bad "tsconfig.json missing"; fi
if [[ -f ".gitignore" ]]; then ok ".gitignore"; else bad ".gitignore missing"; fi

# 4. Git collector produces ops/data/git.json.
echo
echo "[4/4] Git collector"
if command -v npx >/dev/null 2>&1; then
  if npx --yes tsx scripts/collect/git.ts >/dev/null 2>&1; then
    if [[ -s "ops/data/git.json" ]]; then
      ok "ops/data/git.json produced"
    else
      bad "ops/data/git.json not produced or empty"
    fi
  else
    bad "collect:git failed (run: pnpm collect:git)"
  fi
else
  bad "npx not installed; install Node 20+"
fi

echo
if [[ "$fail" -eq 0 ]]; then
  echo -e "\033[32mGate 1: PASS\033[0m"
  exit 0
else
  echo -e "\033[31mGate 1: FAIL\033[0m"
  exit 1
fi
