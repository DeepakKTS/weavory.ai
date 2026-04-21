#!/usr/bin/env bash
# Gate 2 — MCP surface
# Pass iff: server registers exactly the five locked tools, every tool accepts
# valid input and produces structured output, and malformed input produces
# isError. Verification is the MCP integration test suite (real MCP Client ⇄
# Server round trips via @modelcontextprotocol/sdk's InMemoryTransport).
#
# Truthfulness: this script runs `pnpm test` and greps the JSON reporter
# output. No claimed pass without the JSON saying `success: true` AND the
# MCP-integration test file appearing in testResults.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

echo "Gate 2 — MCP surface (repo: $REPO_ROOT)"

# Run the full test suite; Vitest's JSON reporter writes ops/data/tests.json.
echo "[1/3] Running test suite"
if ! pnpm test >/tmp/weavory-gate2.log 2>&1; then
  cat /tmp/weavory-gate2.log | tail -30
  bad "pnpm test failed (see /tmp/weavory-gate2.log)"
fi
ok "pnpm test exit 0"

# Gate on the machine-readable reporter output.
echo
echo "[2/3] Inspecting ops/data/tests.json"
if [[ ! -s "ops/data/tests.json" ]]; then bad "ops/data/tests.json missing or empty"; fi

SUCCESS=$(node -e 'const t=require("./ops/data/tests.json"); process.stdout.write(t.success?"true":"false")')
FAILED=$(node -e 'const t=require("./ops/data/tests.json"); process.stdout.write(String(t.numFailedTests))')
PASSED=$(node -e 'const t=require("./ops/data/tests.json"); process.stdout.write(String(t.numPassedTests))')
TOTAL=$(node -e 'const t=require("./ops/data/tests.json"); process.stdout.write(String(t.numTotalTests))')

if [[ "$SUCCESS" != "true" ]]; then bad "tests.json.success != true"; fi
if [[ "$FAILED" != "0"    ]]; then bad "tests.json.numFailedTests=$FAILED"; fi
ok "tests: $PASSED/$TOTAL passing, 0 failed"

# Assert the MCP integration suite actually ran (not just unit tests).
MCP_RAN=$(node -e 'const t=require("./ops/data/tests.json"); const hit=t.testResults.some(r=>r.name.endsWith("mcp.test.ts")); process.stdout.write(hit?"true":"false")')
if [[ "$MCP_RAN" != "true" ]]; then bad "mcp.test.ts did not run — server wasn't exercised"; fi
ok "mcp.test.ts present in testResults"

# Assert the five-tool set is exactly enforced (T-M-001).
echo
echo "[3/3] Five-tool surface"
T_M_001_PASSED=$(node -e '
const t=require("./ops/data/tests.json");
for (const r of t.testResults) {
  for (const a of r.assertionResults) {
    if (a.title.includes("lists exactly the five declared tools") && a.status==="passed") {
      process.stdout.write("true"); process.exit(0);
    }
  }
}
process.stdout.write("false");
')
if [[ "$T_M_001_PASSED" != "true" ]]; then bad "T-M-001 (five-tool listing) did not pass"; fi
ok "T-M-001 five-tool surface green"

echo
echo -e "\033[32mGate 2: PASS\033[0m"
