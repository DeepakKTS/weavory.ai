/**
 * weavory.ai — MCP server (Gate 2)
 *
 * Registers exactly five tools via @modelcontextprotocol/sdk. Each tool has a
 * Zod input schema; handlers delegate to `src/engine/ops.ts`. All output flows
 * back as `structuredContent` plus a short human-readable `content` item so
 * stock agents and CLIs both render something useful.
 *
 * Public API is locked at five tools (ADR-005). Do not add more without a
 * DECISIONS.md update.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  attest,
  believe,
  forget,
  recall,
  subscribe,
  type RecallInput,
} from "../engine/ops.js";
import { EngineState } from "../engine/state.js";
import { RuntimeWriter } from "../engine/runtime_writer.js";

/**
 * Shipped package version. Exported so cli.ts (banner) and index.ts (public
 * library surface) can reuse the same literal. Hand-edited on every release;
 * tests/unit/version_sync.test.ts enforces the match against package.json at
 * CI time so the literal can't silently drift.
 *
 * Deliberately a string literal — NOT a runtime `readFileSync` on
 * package.json — so this module has zero side effects at load time.
 */
export const VERSION = "0.1.19";

// ---- Shared Zod fragments ----
const JsonValueSchema: z.ZodType = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)])
);

const SubscriptionFiltersSchema = z
  .object({
    subject: z.string().optional(),
    predicate: z.string().optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    min_trust: z.number().min(-1).max(1).optional(),
    reputation_of: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  })
  .strict();

export type CreateServerOptions = {
  /**
   * Attach a RuntimeWriter that snapshots state to ops/data/runtime.json
   * on every op. Default: on, unless WEAVORY_RUNTIME_WRITER=off or running
   * under Vitest (avoids cross-test file contention).
   */
  runtimeWriter?: boolean;
  /**
   * Enable Phase-G.3 adversarial mode (`WEAVORY_ADVERSARIAL=1`). Raises
   * default recall min_trust 0.3 → 0.6 so unknown signers are
   * hostile-until-proven-otherwise. Explicit attestations still win.
   */
  adversarialMode?: boolean;
};

function runtimeWriterDefault(): boolean {
  if (process.env.WEAVORY_RUNTIME_WRITER === "off") return false;
  if (process.env.WEAVORY_RUNTIME_WRITER === "on") return true;
  if (process.env.VITEST === "true") return false;
  return true;
}

export function createServer(
  state: EngineState = new EngineState(),
  opts: CreateServerOptions = {}
): {
  server: McpServer;
  state: EngineState;
} {
  const server = new McpServer({ name: "weavory", version: VERSION });

  // Phase G.3 — adversarial mode is a per-state flag read once at server
  // construction. WEAVORY_ADVERSARIAL=1 enables it globally; the opts field
  // overrides the env var when explicitly set.
  state.adversarialMode =
    opts.adversarialMode ?? process.env.WEAVORY_ADVERSARIAL === "1";

  // Phase G.1: attach a runtime snapshot writer so the dashboard reflects live
  // activity. Attach is idempotent per state; tests running under Vitest bypass
  // it by default to avoid writing to a shared ops/data/runtime.json.
  const attachWriter = opts.runtimeWriter ?? runtimeWriterDefault();
  if (attachWriter) {
    const writer = new RuntimeWriter(state);
    writer.attach();
  }

  // 1. believe --------------------------------------------------------------
  server.registerTool(
    "weavory_believe",
    {
      title: "Write a signed belief",
      description:
        "Record a new signed belief. Fields follow the weavory Belief schema (a NANDA AgentFacts superset). Returns {id, signer_id, entry_hash, ingested_at}.\n\n" +
        "Belief id composition: `id` is the BLAKE3 hash of the canonical belief payload (subject, predicate, object, confidence, valid_from, valid_to, recorded_at, signer_id, causes). `recorded_at` is generated per call from the server's current time (`new Date().toISOString()`), so two calls with identical subject / predicate / object / confidence / signer_seed produce DIFFERENT `id` values (their `recorded_at` timestamps differ by at least a millisecond). Each invocation is a distinct audit-chain entry — the engine does NOT deduplicate on content. For deterministic id generation in tests or deterministic replays, use the lower-level `buildBelief()` library export that accepts an explicit `recorded_at`; that surface is intentionally not exposed through MCP so agents can't backdate beliefs.",
      inputSchema: {
        subject: z.string().min(1).max(2048),
        predicate: z.string().min(1).max(512),
        object: JsonValueSchema,
        confidence: z.number().min(0).max(1).optional(),
        valid_from: z.string().nullable().optional(),
        valid_to: z.string().nullable().optional(),
        causes: z.array(z.string().length(64)).max(64).optional(),
        signer_seed: z.string().min(1).max(256).optional(),
      },
    },
    async (args) => {
      const out = believe(state, args);
      return {
        content: [
          {
            type: "text",
            text: `believed ${out.id} signer=${out.signer_id} (audit=${out.audit_length})`,
          },
        ],
        structuredContent: out,
      };
    }
  );

  // 2. recall ---------------------------------------------------------------
  server.registerTool(
    "weavory_recall",
    {
      title: "Recall matching beliefs",
      description:
        "Find beliefs matching a query. Supports bi-temporal as_of, per-signer trust gating, quarantine filtering, tombstone visibility, and subject/predicate/min_confidence filters.\n\n" +
        "IMPORTANT — query semantics: `query` is a STRICT substring filter, NOT natural language. The string is split on whitespace and EVERY token must appear as a substring in at least one of subject / predicate / JSON.stringify(object). So query='claim events' with a belief having subject='claim/X' and predicate='claim_event' MATCHES ('claim' and 'events' both hit). But query='claim/X all records' would NOT match that belief because 'all' and 'records' are not substrings of any field. When you want to use only the structured filters (filters.subject, filters.predicate, etc.) and not substring-filter the results further, pass query='' (empty string). Empty query matches every candidate and is the safe default for compliance / audit enumeration.\n\n" +
        "Trust floor math (for filtering unattested signers): the default min_trust is 0.3 in normal mode and 0.6 under WEAVORY_ADVERSARIAL=1. Neutral trust for an unattested signer is 0.5, so in normal mode unattested signers ARE visible by default. To enforce 'show me only attested signers' without adversarial mode, pass min_trust: 0.6 explicitly.\n\n" +
        "Trust is per-predicate: the trust gate looks up state.trust[belief.signer_id][belief.predicate]. So an attestation at topic='claim' does NOT gate beliefs with predicate='amount' — you need an attestation at topic='amount' for that. If you're filtering by filters.subject, make sure attestations on the target signers cover each predicate used on that subject (commonly one attest per predicate).\n\n" +
        "Full compliance / audit view showing EVERY belief regardless of trust, quarantine, or tombstone: combine query='' with min_trust: -1, include_quarantined: true, and include_tombstoned: true.\n\n" +
        "Canonical recipes (copy-paste for common patterns):\n" +
        "  • \"Audit everything under a subject\" (full compliance view):\n" +
        "      { query: \"\", filters: { subject: \"X\" }, min_trust: -1, include_quarantined: true, include_tombstoned: true, top_k: 100 }\n" +
        "  • \"Live view, attested signers only\" (hide unattested without adversarial mode):\n" +
        "      { query: \"\", filters: { subject: \"X\" }, min_trust: 0.6 }\n" +
        "  • \"Find beliefs containing a specific literal string\" (substring search):\n" +
        "      { query: \"needle\", min_trust: -1 }\n" +
        "  • \"Replay state at a past instant\" (bi-temporal):\n" +
        "      { query: \"\", filters: { subject: \"X\" }, as_of: \"<ISO 8601>\", min_trust: -1 }\n" +
        "  • \"Drain a subscription queue\":\n" +
        "      { query: \"\", subscription_id: \"sub_<hex>\" }",
      inputSchema: {
        query: z
          .string()
          .max(2048)
          .describe(
            "Whitespace-tokenized substring filter. Every non-empty token must appear as a substring in subject / predicate / JSON.stringify(object) — case-insensitive, AND semantics. Pass '' (empty string) to disable substring filtering and match all beliefs that pass the other filters. Do NOT put natural-language words here; it is a literal substring match, not a semantic search."
          ),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Maximum beliefs returned (default 10, max 100). For audit / compliance enumeration where silent truncation is unacceptable, pass top_k: 100. The total_matched count in the response always reflects the full match set regardless of top_k, so truncation is visible as `total_matched > beliefs.length`."
          ),
        as_of: z.string().nullable().optional(),
        min_trust: z.number().min(-1).max(1).optional(),
        include_quarantined: z.boolean().optional(),
        include_tombstoned: z
          .boolean()
          .optional()
          .describe(
            "If true, live recall surfaces tombstoned (forgotten) beliefs with their invalidated_at populated. Default false. Orthogonal to as_of — use include_tombstoned for 'show me everything including forgotten' in the current timeline; use as_of for 'show me state at time T'."
          ),
        filters: SubscriptionFiltersSchema.optional(),
        subscription_id: z.string().regex(/^sub_[0-9a-f]+$/u).optional(),
        include_conflicts: z.boolean().optional(),
        merge_strategy: z.enum(["lww", "consensus"]).optional(),
      },
    },
    async (args) => {
      const input: RecallInput = args as RecallInput;
      const out = recall(state, input);
      const header = input.subscription_id
        ? `drained ${out.delivered_count ?? 0} from ${input.subscription_id}` +
          (out.dropped_count ? ` (dropped=${out.dropped_count})` : "")
        : `recalled ${out.beliefs.length} / ${out.total_matched} match(es)` +
          (input.as_of ? ` @as_of=${input.as_of}` : "");
      const flagSummary = (() => {
        let inv = 0;
        let q = 0;
        for (const b of out.beliefs) {
          if (b.invalidated_at) inv++;
          if (b.quarantined) q++;
        }
        const parts: string[] = [];
        if (inv > 0) parts.push(`tombstoned=${inv}`);
        if (q > 0) parts.push(`quarantined=${q}`);
        return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
      })();
      const lines: string[] = [header + flagSummary];
      const MAX_SHOWN = 5;
      for (const b of out.beliefs.slice(0, MAX_SHOWN)) {
        const idShort = b.id.slice(0, 16) + "…";
        const sigShort = b.signer_id.slice(0, 12) + "…";
        const objStr = (() => {
          const s = JSON.stringify(b.object);
          return s.length > 80 ? s.slice(0, 77) + "…" : s;
        })();
        const extras: string[] = [];
        if (b.invalidated_at) extras.push(`invalidated_at=${b.invalidated_at}`);
        if (b.quarantined) extras.push(`quarantined=true`);
        const extrasStr = extras.length > 0 ? ` [${extras.join(" ")}]` : "";
        lines.push(
          `  • ${idShort} ${b.subject} / ${b.predicate} → ${objStr} ` +
            `(confidence=${b.confidence}, signer=${sigShort})${extrasStr}`
        );
      }
      if (out.beliefs.length > MAX_SHOWN) {
        lines.push(`  … and ${out.beliefs.length - MAX_SHOWN} more`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: out,
      };
    }
  );

  // 3. subscribe ------------------------------------------------------------
  server.registerTool(
    "weavory_subscribe",
    {
      title: "Subscribe to a semantic pattern",
      description:
        "Register a semantic subscription. Returns a subscription_id. Matching beliefs can be polled via recall(filters); real-time SSE delivery is served out-of-band at /events/:subscription_id (dashboard mode).\n\n" +
        "Pattern semantics (v0.1.14+): `pattern` is whitespace-tokenized with the same AND-across-fields substring match as `weavory_recall`'s `query`. Every non-empty token must appear as a substring in subject / predicate / JSON.stringify(object) of each published belief — case-insensitive, AND semantics. Pass `pattern: \"\"` to queue every belief that matches the structured `filters` block (subject / predicate / min_confidence). A multi-word descriptive pattern like \"traffic watch\" matches beliefs with token `traffic` in the predicate AND token `watch` anywhere else — it does NOT look for the literal 14-char string.",
      inputSchema: {
        pattern: z
          .string()
          .max(2048)
          .describe(
            "Whitespace-tokenized substring filter (same semantics as weavory_recall.query). Every non-empty token must appear in subject / predicate / JSON.stringify(object) — AND semantics, case-insensitive. Pass '' (empty string) to match all beliefs that pass the structured filters."
          ),
        filters: SubscriptionFiltersSchema.optional(),
        signer_seed: z.string().min(1).max(256).optional(),
        queue_cap: z.number().int().min(1).max(100000).optional(),
      },
    },
    async (args) => {
      const out = subscribe(state, args);
      const signerClause = out.signer_id ? ` signer=${out.signer_id}` : "";
      return {
        content: [
          {
            type: "text",
            text: `subscription ${out.subscription_id} created${signerClause} (queue_cap=${out.queue_cap})`,
          },
        ],
        structuredContent: out,
      };
    }
  );

  // 4. attest ---------------------------------------------------------------
  server.registerTool(
    "weavory_attest",
    {
      title: "Attest trust for a signer × topic",
      description:
        "Raise or lower the attestor's trust vector for (signer_id, topic). Affects default recall ranking and quarantine. Score is clamped to [-1, 1].\n\n" +
        "signer_id must be the full 64-hex Ed25519 public key (as returned in weavory_believe's text/structuredContent).\n\n" +
        "IMPORTANT — topic/predicate alignment: recall's trust gate looks up trust by (signer_id, belief.predicate). So attesting at topic='X' ONLY affects recall filtering for beliefs whose predicate is 'X'. If you want to raise trust for a signer's beliefs with predicate='amount', attest at topic='amount' — attesting at topic='claim' will NOT gate 'amount'-predicated beliefs. To cover multiple predicates for the same signer, call attest once per predicate.\n\n" +
        "Trust deltas compose: additional attest calls on the same (signer_id, topic) accumulate (averaged across attestors). One attestor with score >= 0.2 is enough to push an unattested signer (neutral 0.5) past the 0.6 adversarial-mode floor for that topic/predicate.",
      inputSchema: {
        signer_id: z.string().regex(/^[0-9a-f]{64}$/u),
        topic: z.string().min(1).max(512),
        score: z.number().min(-1).max(1),
        attestor_seed: z.string().min(1).max(256).optional(),
      },
    },
    async (args) => {
      const out = attest(state, args);
      return {
        content: [
          {
            type: "text",
            text: `attested ${out.signer_id} on "${out.topic}" → ${out.applied_score.toFixed(2)} attestor=${out.attestor_id}`,
          },
        ],
        structuredContent: out,
      };
    }
  );

  // 5. forget ---------------------------------------------------------------
  server.registerTool(
    "weavory_forget",
    {
      title: "Tombstone a belief (OR-set remove)",
      description:
        "Mark a belief as invalidated from the current point in transaction-time. Historical queries (recall with as_of) still see the belief; live recall does not.",
      inputSchema: {
        belief_id: z.string().length(64),
        reason: z.string().max(512).optional(),
        forgetter_seed: z.string().min(1).max(256).optional(),
      },
    },
    async (args) => {
      const out = forget(state, args);
      const text = out.found
        ? `forgot ${out.belief_id} invalidated_at=${out.invalidated_at} entry_hash=${out.entry_hash}`
        : `no such belief: ${out.belief_id}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: out,
      };
    }
  );

  return { server, state };
}

/** CLI entrypoint: wire stdio transport and keep the process alive.
 *
 * Accepts a pre-built EngineState so the CLI can open + rehydrate a
 * persistent store first, verify the audit chain, and only then hand the
 * state to the MCP transport. Defaults to a fresh in-memory state when no
 * argument is provided (preserves the original Phase-1 behavior for tests
 * and any programmatic embedders).
 */
export async function runStdio(state?: EngineState): Promise<void> {
  const { server } = createServer(state);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
