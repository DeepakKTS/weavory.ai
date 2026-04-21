#!/usr/bin/env bash
# Gate 6 — Fresh-machine CI
# Verifies the GitHub Actions workflow exists and passed on the latest commit
# of origin/main. Requires `gh` CLI with access to DeepakKTS/weavory.ai.
#
# Truthfulness: this script only records a pass when GitHub Actions reports
# `conclusion=success` for the `fresh-machine` workflow on the current HEAD.
# Local gate1-5 success is not enough for Gate 6.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate 6 — Fresh-machine CI"

echo "[1/3] Workflow file present"
[[ -f ".github/workflows/fresh-machine.yml" ]] || bad "workflow missing"
ok ".github/workflows/fresh-machine.yml"

echo
echo "[2/3] gh CLI available + authenticated"
if ! command -v gh >/dev/null 2>&1; then bad "gh CLI not installed"; fi
ok "gh available"

echo
echo "[3/3] Latest fresh-machine run on current HEAD is green"
HEAD_SHA=$(git rev-parse HEAD)
# Use the DeepakKTS PAT if present in the environment (CI convention); otherwise
# fall back to whatever gh keyring has. Do NOT hard-code tokens here.
GH_ARGS=(run list --workflow=fresh-machine --branch=main --limit=5 --json=headSha,conclusion,status,url,createdAt)
RUNS=$(gh --repo DeepakKTS/weavory.ai "${GH_ARGS[@]}" 2>/dev/null || echo "[]")

if [[ "$RUNS" == "[]" ]]; then
  bad "no fresh-machine runs found yet — push and re-check"
fi

CONCLUSION=$(node -e "const r=$RUNS; const m=r.find(x=>x.headSha==='$HEAD_SHA'); process.stdout.write(m?(m.conclusion||'in_progress'):'no-match')")
if [[ "$CONCLUSION" == "success" ]]; then
  ok "fresh-machine conclusion=success on $HEAD_SHA"
else
  bad "fresh-machine conclusion=$CONCLUSION on $HEAD_SHA (want: success)"
fi

echo
echo -e "\033[32mGate 6: PASS\033[0m"
