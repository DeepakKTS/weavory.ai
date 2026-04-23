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
export const VERSION = "0.1.9";

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
        "Record a new signed belief. Fields follow the weavory Belief schema (a NANDA AgentFacts superset). Returns {id, signer_id, entry_hash, ingested_at}.",
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
        content: [{ type: "text", text: `believed ${out.id} (signer=${shortId(out.signer_id)}, audit=${out.audit_length})` }],
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
        "Find beliefs matching a query. Supports bi-temporal as_of, per-signer trust gating, quarantine filtering, and subject/predicate/min_confidence filters.",
      inputSchema: {
        query: z.string().max(2048),
        top_k: z.number().int().min(1).max(100).optional(),
        as_of: z.string().nullable().optional(),
        min_trust: z.number().min(-1).max(1).optional(),
        include_quarantined: z.boolean().optional(),
        filters: SubscriptionFiltersSchema.optional(),
        subscription_id: z.string().regex(/^sub_[0-9a-f]+$/u).optional(),
        include_conflicts: z.boolean().optional(),
        merge_strategy: z.enum(["lww", "consensus"]).optional(),
      },
    },
    async (args) => {
      const input: RecallInput = args as RecallInput;
      const out = recall(state, input);
      const summary =
        input.subscription_id
          ? `drained ${out.delivered_count ?? 0} from ${input.subscription_id}` +
            (out.dropped_count ? ` (dropped=${out.dropped_count})` : "")
          : `recalled ${out.beliefs.length} / ${out.total_matched} match(es)` +
            (input.as_of ? ` @as_of=${input.as_of}` : "");
      return {
        content: [{ type: "text", text: summary }],
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
        "Register a semantic subscription. Returns a subscription_id. Matching beliefs can be polled via recall(filters); real-time SSE delivery is served out-of-band at /events/:subscription_id (dashboard mode).",
      inputSchema: {
        pattern: z.string().min(1).max(2048),
        filters: SubscriptionFiltersSchema.optional(),
        signer_seed: z.string().min(1).max(256).optional(),
        queue_cap: z.number().int().min(1).max(100000).optional(),
      },
    },
    async (args) => {
      const out = subscribe(state, args);
      return {
        content: [{ type: "text", text: `subscription ${out.subscription_id} created (queue_cap=${out.queue_cap})` }],
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
        "Raise or lower the attestor's trust vector for (signer_id, topic). Affects default recall ranking and quarantine. Score is clamped to [-1, 1].",
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
            text: `attested ${shortId(out.signer_id)} on "${out.topic}" → ${out.applied_score.toFixed(2)}`,
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
      return {
        content: [
          { type: "text", text: out.found ? `forgot ${out.belief_id}` : `no such belief: ${out.belief_id}` },
        ],
        structuredContent: out,
      };
    }
  );

  return { server, state };
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
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
