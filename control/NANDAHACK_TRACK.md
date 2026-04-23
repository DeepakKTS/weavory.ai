# NandaHack 2026 track mapping (INTERNAL — do NOT surface publicly)

> Internal planning note mapping weavory.ai to the NandaHack 2026
> track system. Keep out of any public surface (README, docs/, npm
> tarball, Pages). Public copy uses plain-English regulatory framing
> ("regulated industries", "compliance-grade", "auditable") instead
> of NandaHack-internal track names.

## Chosen track: Responsible AI

NandaHack Infrastructure-Agents theme splits into five tracks.
Weavory's strongest fit — and the one highest-leverage for
VC / industry narrative — is **Responsible AI**, defined as:

> *Safety, governance, red-teaming solutions. Pipeline impact:
> reduces enterprise adoption friction. Revenue lever: unlocks
> regulated industry deals (BFSI, healthcare).*

## Why this track fits weavory exactly

- **Safety / governance substrate.** Every weavory primitive
  (Ed25519 signatures, per-(signer, predicate) trust gating,
  append-only hash-chained audit, `as_of` bi-temporal replay,
  `forget` tombstones, `include_quarantined` compliance view) is
  a Responsible-AI primitive. Every other NandaHack track builds
  WHAT agents do; weavory proves WHAT THEY DID.
- **BFSI + healthcare unlock.** Track revenue lever is explicit;
  weavory's flagship `examples/bfsi_claims_triage.ts` demo is the
  concrete proof point. Motor-insurance claims-triage with
  attacker injection, quarantine, audit recovery, regulator
  rewind (Scene 7, v0.1.18), collusion-ring detection (Scene 8,
  v0.1.18).
- **Stock-agent rubric.** NandaHack's published rule: "a judge
  hands a stock OpenClaw agent your instructions — if it can use
  what you built, you pass." Weavory's `tests/judge/gate7_simulation.ts`
  runs Claude Opus 4.7 against the README + five tools, grounded
  in docs only. Transcript captured at `docs/evidence/stock-agent-session-v0.1.18.md`.

## Other tracks — why not primary

- **Client 0** (internal copilots, productivity): weavory is
  infrastructure, not a user-facing copilot. Could arguably fit
  if reframed, but loses the regulatory-unlock narrative.
- **Enterprise AI (incl. Modernization)** (SAP, legacy, agents):
  weavory isn't a modernization play; it's a substrate. Could
  slot under Enterprise AI as the "memory layer" dependency for
  other solutions, but weakens the pitch ("why weavory over
  Mem0?") because Enterprise AI judges will compare with pure-play
  memory products.
- **Sales AI Enablement** (RFP agents, account insights): not a
  weavory-native fit. No deal-identification logic in weavory.
- **Executive AI Coaching** (C-suite copilots): not a weavory-native
  fit.

## Public framing discipline

- Public surfaces use plain English: "regulated industries",
  "compliance-grade", "auditable", "Responsible AI". DO NOT
  mention "Responsible AI track", "NandaHack tracks", or the
  five-track table on any public page.
- Keep tasteful NandaHack attribution in exactly one footer line
  (`Built for NandaHack 2026 @ MIT Media Lab`) per the feedback
  memory. Everything else about the hackathon stays internal.
- Cloud / Enterprise moat-guard still applies: no pricing, no
  SSO / SOC2 specifics, no architecture beyond "Cloud tier
  planned".

## Submission deliverables (Responsible-AI track-aligned)

Minimum submission payload:

- **Pitch video URL** (Unlisted → public on submit) — 3-min script
  at `control/PITCH_SCRIPT.md`, recorded AFTER v0.1.18 ships so
  SHOW cues hit the live dashboard.
- **Repo URL** — <https://github.com/DeepakKTS/weavory.ai>.
- **One-liner install** — `npx -y @weavory/mcp start`.
- **Fresh-machine CI run URL** — latest green on v0.1.18 from
  `.github/workflows/fresh-machine.yml`.
- **Stock-agent transcript** — `docs/evidence/stock-agent-session-v0.1.18.md`
  (Responsible-AI rubric satisfaction).
- **Live demo URL** — <https://deepakkts.github.io/weavory.ai/demo/>
  (REPLAY mode with fixture-baked BFSI session; judge can scrub
  timeline without installing).
- **Abstract** — derived from the new Responsible-AI hero in root
  `README.md`. One paragraph. Regulatory framing, BFSI + healthcare
  unlock, five-tool MCP surface, Apache-2.0.
