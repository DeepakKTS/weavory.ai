# PITCH_SCRIPT.md — 3-minute demo narration

> **Internal artifact.** Scripted cues for a 3-minute screen-recorded
> demo. Not part of the user-facing docs surface. If you are evaluating
> weavory.ai, start at [`../docs/README.md`](../docs/README.md) instead.

Target duration: **2:55–3:05**. Beyond 3 minutes you lose the room.

Each beat has three cue lanes:

- **SAY** — spoken voiceover (aim for 150–165 words/min).
- **TYPE** — literal command typed into the terminal, or a link clicked.
- **SHOW** — what should be visible on screen while SAY plays.

---

## Pre-flight (before recording)

1. Warm the checkout: `pnpm install && pnpm build`
2. Pre-run the rehearsal so the audit + incident dirs exist:
   `bash scripts/rehearsal.sh` (5 s, all green)
3. Open three terminal tabs:
   - Tab A: repo root, terminal cleared, prompt minimal
   - Tab B: same, reserved for the replay command
   - Tab C: empty `ls ~/.weavory-data/` ready
4. Browser tabs ready (hidden until cued):
   - [github.com/DeepakKTS/weavory.ai](https://github.com/DeepakKTS/weavory.ai)
   - [npmjs.com/package/@weavory/mcp](https://www.npmjs.com/package/@weavory/mcp)
   - [deepakkts.github.io/weavory.ai](https://deepakkts.github.io/weavory.ai/)
5. Record at 1440×900 or higher, font size ≥ 16 pt, terminal dark theme.

---

## 0:00–0:15 · Hook

**SAY:** "When two AI agents disagree, today you have no idea which one
to believe. Weavory gives your agents a cryptographically signed shared
memory — so when one of them lies, you can prove it, revoke it, and
replay the whole conversation later."

**SHOW:** Landing page hero, then cut to the GitHub repo tab showing
the Apache-2.0 badge and the 197/197 tests-green badge.

**TYPE:** (no typing in this window — pure voiceover)

---

## 0:15–0:45 · Problem

**SAY:** "Every multi-agent stack today has the same hole. Agents
share state through a plain memory product — something like a vector
DB or a shared scratchpad. Nothing proves who wrote what. Nothing
blocks a compromised agent from poisoning the others. And when a
regulator asks what decided this claim, you have no answer. That's the
gap. And in regulated industries — banking, insurance, healthcare —
that gap is the reason nobody can ship multi-agent systems to
production."

**SHOW:** A two-column diagram on screen (static image is fine):
left column "Today — shared memory: no provenance, no trust, no
replay." Right column "Weavory — shared beliefs: Ed25519 signed,
trust-gated, bi-temporal replay."

---

## 0:45–1:30 · One-command demo

**SAY:** "Weavory ships as a five-tool MCP server. One npm install, or
one Docker pull, and any MCP-capable agent speaks it. Here's four
agents collaborating on a real insurance claim."

**TYPE (Tab A):**
```
pnpm exec tsx examples/bfsi_claims_triage.ts
```

**SHOW:** Terminal output. Let the demo scroll naturally. The lines to
highlight as they appear (you don't need to pause — they come out in
sequence and the next beat calls them out):
- `[bfsi] five agents connected: intake · fraud · underwriter · approver · mallet(attacker)`
- `[bfsi] [1/6] intake logged claim …`
- `[bfsi] [2/6] fraud-detector published risk_score …`
- `[bfsi] [3/6] underwriter attested upstream signers …`

**SAY (over the last line):** "Four honest agents — intake, fraud,
underwriter, approver. And one attacker, Mallet, who's about to try to
forge an approval."

---

## 1:30–2:15 · The trust-gate moment

**SAY:** "Mallet is an unknown signer. He hasn't been attested by
anyone on the policy team. Watch what happens when he pushes a
belief."

**SHOW:** The output continues. Pause briefly on these two lines
(both appear verbatim in the demo output):
- `[bfsi] [4/6] mallet attempted to publish 'approval' — signer unattested`
- `[bfsi] [5/6] attacker QUARANTINED from approver's default recall`

**SAY:** "Weavory's recall is trust-gated by default. An unattested
signer sits at neutral trust — below the default floor — so the
approver's query literally doesn't see the forged belief. No prompt
engineering. No custom filter. It's in the engine. The final approval
references only the three signed, attested upstream beliefs — you can
see the audit_trail length right there."

**SHOW:** Highlight `APPROVED $42,000 (audit_trail length=3)` on
screen.

**SAY:** "Compliance view is one flag: min_trust equals minus one.
That surfaces everything — including what Mallet tried — so forensics
can see the full picture, not just what succeeded."

---

## 2:15–2:45 · Replay the incident

**SAY:** "Every incident is exported as a self-contained JSON file —
every signed belief, every audit entry, the whole chain. You can
replay it off-process, on a different machine, months later."

**TYPE (Tab B):**
```
pnpm exec weavory replay --from ops/data/incidents/$(ls -t ops/data/incidents/ | head -1)
```

**SHOW:** Replay output. The key line to pause on:
- `verify=ok · audit_length=<N>` (chain re-verifies off-process)

**SAY:** "That's what a regulator gets when they ask what decided this
claim. A signed, hash-chained record they can re-verify themselves.
Nothing is erased — forget just tombstones; bi-temporal recall can
always ask 'what did the system know at time T?'"

---

## 2:45–3:00 · Close

**SAY:** "Weavory is Apache-2.0 today, on npm and GitHub Container
Registry. The five-tool API is locked. Install in under two minutes.
The hosted tier for teams that don't want to self-operate is coming —
same core, managed. Built for NandaHack 2026. Ping me if your stack
needs provenance its regulators can trust."

**SHOW:** Split-screen: left, the `npm view @weavory/mcp` page;
right, the repo `README.md` with the install block visible. Last
frame: a single closing card — `weavory.ai · Apache-2.0 · npm install
@weavory/mcp`.

---

## Guardrails (non-negotiable)

- **Do NOT** name specific Cloud/Enterprise features (pricing, SSO,
  SOC2, multi-tenancy, architecture). The Cloud pitch is one line and
  stays vague — "hosted tier is coming, same core, managed." Anything
  more leaks the moat.
- **Do NOT** claim full CRDT — the engine is honestly labeled
  "CRDT-adjacent" in the docs. Don't drift from that in the
  voiceover.
- **Do NOT** read environment variables (WEAVORY_ADVERSARIAL,
  WEAVORY_POLICY_FILE, WEAVORY_RATE_LIMIT_PER_SIGNER) aloud. They
  belong in docs/INSTALL.md and docs/SECURITY.md — judges who care
  will follow the link.
- **Do** leave two full seconds of silence before and after the pitch.
  It makes re-cuts easier and the room breathes.

## Reshoot triggers

If the BFSI demo prints anything other than:

```
APPROVED $42,000 (audit_trail length=3)
…
final audit chain length=<N> · verify=ok ✓
```

…stop the take. Something broke. Run `pnpm test && bash scripts/rehearsal.sh`
first and confirm green before recording again.
