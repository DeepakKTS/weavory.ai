# Submission evidence

Captured artifacts that accompany weavory.ai's NandaHack 2026 submission.
Each file here is regenerable from source; the checked-in copies are frozen
evidence tied to a specific tagged release.

## Files

- **`stock-agent-session-v<VERSION>.md`** — Redacted transcript of a stock
  Claude Opus 4.7 agent using weavory's five MCP tools from
  `docs/README.md` alone. Satisfies the "Responsible AI" track rubric:
  *"a judge hands a stock OpenClaw agent your instructions — if it can
  use what you built, you pass."* Regenerate with
  `pnpm exec tsx scripts/capture-gate7-transcript.ts` (requires
  `ANTHROPIC_API_KEY` in env). The capture script reads the key from env,
  passes it to the SDK, and never persists it to disk. A redactor in the
  same script scrubs `sk-ant-*` patterns and shortens 64-hex signer /
  belief ids to 12-hex / 16-hex prefixes.

## Regenerating

```bash
export ANTHROPIC_API_KEY="sk-ant-…"   # only for the duration of the capture
pnpm exec tsx scripts/capture-gate7-transcript.ts
unset ANTHROPIC_API_KEY
```

Review the transcript by hand before committing — confirm signer ids are
truncated, no API key slipped through, and the pass criterion at the
bottom of the file is `✓`.

## Why kept in-tree

The transcripts are small (< 50 KB each), frozen at release time, and
useful to reviewers who don't want to install an Anthropic SDK or spend
API credit just to reproduce the submission evidence. For large or
sensitive incident exports, see `ops/data/incidents/` (gitignored; see
`docs/SECURITY.md` § SEC-05).
