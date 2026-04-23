#!/usr/bin/env bash
# scripts/rehearsal.sh — fresh-machine end-to-end rehearsal
#
# Chains the core verify gates in the order a reviewer would exercise them
# and emits machine-readable evidence to ops/data/rehearsal.json. Per-gate
# stdout/stderr is captured under ops/data/rehearsal-logs/ for post-hoc
# inspection.
#
# Gates chained:
#   gate1         · Bootstrap (control files + git collector)
#   gate2         · MCP surface (Vitest full suite via @modelcontextprotocol/sdk)
#   gate3         · Two-agent belief exchange + signature verification
#   gate4         · Adversarial filtering (trust quarantine)
#   gate5         · Bi-temporal recall after forget
#   gate_bfsi     · BFSI claims-triage demo (the killer end-to-end)
#   gate_dashboard · Dashboard SSE sidecar (Phase N.2 — SSE + auth + rate limit)
#
# Skipped on purpose:
#   gate6         · Fresh-machine CI itself — redundant to run locally
#   gate7         · Stock-agent simulation — requires ANTHROPIC_API_KEY
#   composite gates   · swarm/tamper/temporal/escrow/e2e — covered elsewhere
#
# Usage:
#   bash scripts/rehearsal.sh
#
# Exit codes:
#   0  all gates passed; rehearsal.json written with all_passed=true
#   1  one or more gates failed; rehearsal.json written with all_passed=false
#   2  missing prerequisite (node, pnpm, or jq not on PATH)
#   3  install / build step failed before gates could even run

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="ops/data/rehearsal-logs"
OUT_FILE="ops/data/rehearsal.json"

# ---------- 0. Prereq check ----------

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "rehearsal: missing prerequisite: %s\n" "$1" >&2
    printf "  install hint: %s\n" "$2" >&2
    exit 2
  fi
}

need node    "https://nodejs.org (Node >= 20 required)"
need pnpm    "corepack enable && corepack prepare pnpm@latest --activate"
need jq      "brew install jq  ·  apt-get install -y jq"
need python3 "macOS: preinstalled  ·  Ubuntu: apt-get install -y python3"

NODE_VERSION="$(node --version)"
PNPM_VERSION="$(pnpm --version)"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
GIT_DIRTY="false"
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  GIT_DIRTY="true"
fi

printf "rehearsal: weavory.ai on %s-%s · node %s · pnpm %s\n" \
  "$PLATFORM" "$ARCH" "$NODE_VERSION" "$PNPM_VERSION"
printf "rehearsal: commit %s (%s%s)\n" "$GIT_COMMIT" "$GIT_BRANCH" \
  "$( [ "$GIT_DIRTY" = "true" ] && printf ' · dirty' )"

# ---------- 1. Install + build (skip if already done) ----------

mkdir -p "$LOG_DIR"

if [ ! -d node_modules ]; then
  printf "rehearsal: installing dependencies…\n"
  if ! pnpm install --frozen-lockfile > "$LOG_DIR/install.log" 2>&1; then
    printf "rehearsal: pnpm install FAILED — see %s\n" "$LOG_DIR/install.log" >&2
    exit 3
  fi
fi

if [ ! -f dist/cli.js ]; then
  printf "rehearsal: building dist/…\n"
  if ! pnpm build > "$LOG_DIR/build.log" 2>&1; then
    printf "rehearsal: pnpm build FAILED — see %s\n" "$LOG_DIR/build.log" >&2
    exit 3
  fi
fi

# ---------- 2. Run gates ----------

# Pair: gate_id · human label
GATES=(
  "gate1:Bootstrap"
  "gate2:MCP surface"
  "gate3:Two-agent belief exchange"
  "gate4:Adversarial filtering"
  "gate5:Bi-temporal recall"
  "gate_bfsi:BFSI claims-triage"
  "gate_dashboard:Dashboard SSE sidecar"
)

GATES_JSON="[]"
ALL_PASSED="true"
TOTAL_START="$(date +%s)"

for entry in "${GATES[@]}"; do
  gate_id="${entry%%:*}"
  gate_label="${entry#*:}"
  log_path="$LOG_DIR/${gate_id}.log"
  script_path="scripts/verify/${gate_id}.sh"

  printf "\nrehearsal: [%s] %s\n" "$gate_id" "$gate_label"

  start_ms="$(python3 -c 'import time;print(int(time.time()*1000))')"
  if bash "$script_path" > "$log_path" 2>&1; then
    passed="true"
    printf "rehearsal: [%s] PASS\n" "$gate_id"
  else
    passed="false"
    ALL_PASSED="false"
    printf "rehearsal: [%s] FAIL — see %s\n" "$gate_id" "$log_path" >&2
  fi
  end_ms="$(python3 -c 'import time;print(int(time.time()*1000))')"
  duration_sec="$(python3 -c "print(round(($end_ms - $start_ms) / 1000.0, 2))")"

  GATES_JSON="$(jq --arg id "$gate_id" \
                   --arg label "$gate_label" \
                   --argjson duration "$duration_sec" \
                   --argjson passed "$passed" \
                   --arg log "$log_path" \
                   '. += [{id: $id, label: $label, duration_sec: $duration, passed: $passed, log_path: $log}]' \
                   <<<"$GATES_JSON")"
done

TOTAL_END="$(date +%s)"
TOTAL_DURATION="$((TOTAL_END - TOTAL_START))"

# ---------- 3. Emit JSON evidence ----------

GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -n \
  --arg schema_version "1.0.0" \
  --arg generated_at "$GENERATED_AT" \
  --arg commit "$GIT_COMMIT" \
  --arg branch "$GIT_BRANCH" \
  --argjson dirty "$GIT_DIRTY" \
  --arg node "$NODE_VERSION" \
  --arg pnpm "$PNPM_VERSION" \
  --arg platform "$PLATFORM" \
  --arg arch "$ARCH" \
  --argjson gates "$GATES_JSON" \
  --argjson all_passed "$ALL_PASSED" \
  --argjson total_duration "$TOTAL_DURATION" \
  '{
    schema_version: $schema_version,
    generated_at: $generated_at,
    git: { commit: $commit, branch: $branch, dirty: $dirty },
    runtime: { node: $node, pnpm: $pnpm, platform: $platform, arch: $arch },
    gates: $gates,
    all_passed: $all_passed,
    total_duration_sec: $total_duration
  }' > "$OUT_FILE"

printf "\nrehearsal: wrote %s\n" "$OUT_FILE"
printf "rehearsal: total duration %ss · all_passed=%s\n" "$TOTAL_DURATION" "$ALL_PASSED"

if [ "$ALL_PASSED" = "true" ]; then
  printf "\n\033[32mREHEARSAL: PASS\033[0m\n"
  exit 0
else
  printf "\n\033[31mREHEARSAL: FAIL\033[0m\n"
  exit 1
fi
