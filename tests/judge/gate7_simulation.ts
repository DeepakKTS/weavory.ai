/**
 * tests/judge/gate7_simulation.ts — Gate 7 (README-only stock-agent judge sim)
 *
 * Setup:
 *   1. Spin up a weavory MCP server with shared EngineState.
 *   2. Seed Alice's congestion belief directly against the engine.
 *   3. Build Anthropic tool definitions by listing weavory's MCP tools.
 *
 * Run:
 *   4. Give Claude Opus 4.7 only the contents of docs/README.md as the
 *      system prompt (cached) plus a scripted judge prompt as the user turn.
 *   5. Manual tool-use loop: every time Claude issues a tool_use block, we
 *      forward the call to the weavory MCP server and return the
 *      structuredContent as a tool_result.
 *   6. Loop until stop_reason === "end_turn" or max-iteration safety cap.
 *
 * Pass criterion:
 *   - Claude's final assistant text contains both "congested" and "14"
 *     (case-insensitive) — i.e. it produced the scripted reading.
 *
 * Requires: ANTHROPIC_API_KEY in the environment. Skips (exit 2) if missing.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { believe as engineBelieve } from "../../src/engine/ops.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const README_PATH = resolve(REPO_ROOT, "docs/README.md");

// Guard: no key → clean skip (exit 2). CI treats it as "not green yet".
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("[gate7] ANTHROPIC_API_KEY not set — skipping judge simulation.");
  process.exit(2);
}

// Claude Opus 4.7 with adaptive thinking and xhigh effort — best settings for
// agentic tool-use per the claude-api skill.
const MODEL = "claude-opus-4-7";
const MAX_ITERATIONS = 12;

type ToolCallResult = {
  ok: boolean;
  text: string;
  structured?: unknown;
};

async function callWeavoryTool(
  mcp: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  try {
    const res = await mcp.callTool({ name, arguments: args });
    const text = Array.isArray(res.content)
      ? res.content
          .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
    const structured = (res as { structuredContent?: unknown }).structuredContent;
    // Include both a terse human line and the full structured payload so the
    // model has exact belief ids / signer ids to reference in subsequent calls.
    const combined =
      (text ? text + "\n" : "") +
      (structured ? "structured:\n" + JSON.stringify(structured, null, 2) : "");
    return { ok: !res.isError, text: combined.trim(), structured };
  } catch (err) {
    return {
      ok: false,
      text: "tool error: " + (err instanceof Error ? err.message : String(err)),
    };
  }
}

async function main(): Promise<void> {
  console.log("[gate7] starting judge simulation");

  // 1-2. Server + state + seed Alice's belief directly.
  const { server, state } = createServer();
  const aliceBelief = engineBelieve(state, {
    subject: "scenario:traffic-cambridge",
    predicate: "observation",
    object: { congested: true, eta_delta_min: 14, signal_source: "field-sensor-7" },
    signer_seed: "alice",
  });
  console.log(
    `[gate7] seeded alice's belief ${aliceBelief.id.slice(0, 12)}… signer=${aliceBelief.signer_id.slice(0, 12)}…`
  );

  // Wire an MCP client to the same server/state.
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const mcp = new Client({ name: "gate7-bridge", version: "1.0.0" });
  await mcp.connect(clientT);

  // 3. Build Anthropic tool definitions from weavory's MCP tool list.
  const tools = (await mcp.listTools()).tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object" }) as Anthropic.Tool.InputSchema,
  })) satisfies Anthropic.Tool[];
  console.log(`[gate7] bridging ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

  // 4. Construct the system prompt. README is verbatim + prompt-cached so
  //    repeated iterations in the loop don't re-bill the prefix.
  const readme = readFileSync(README_PATH, "utf8");
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text:
        "You are Bob, an AI agent participating in the NandaHack 2026 Phase 1 judge test.\n\n" +
        "Below is the full contents of weavory.ai's judge runbook (docs/README.md). You have " +
        "access to weavory's five MCP tools — use them exactly as the runbook describes. " +
        "Follow the 60-second walkthrough for Bob's side of the two-agent exchange. When you " +
        "have your answer, reply with that answer as plain text in a single short sentence " +
        "and stop — do not call any more tools. Be terse.\n\n" +
        "=== docs/README.md ===\n" +
        readme,
      cache_control: { type: "ephemeral" },
    },
  ];

  const userPrompt =
    "Scenario: Alice has already published a belief about Cambridge traffic. " +
    "Find it, assess whether you should trust her, and report in one sentence whether " +
    "the city is congested and by how many minutes. Use only the weavory MCP tools.";

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];

  const client = new Anthropic({ apiKey });

  let finalText = "";
  let iterations = 0;
  let stop_reason: string | null = null;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
      system,
      tools,
      messages,
    });

    const usage = resp.usage;
    console.log(
      `[gate7] iter ${iterations}: stop=${resp.stop_reason}` +
        ` input=${usage.input_tokens} output=${usage.output_tokens}` +
        ` cache_read=${usage.cache_read_input_tokens ?? 0}` +
        ` cache_write=${usage.cache_creation_input_tokens ?? 0}`
    );

    // Collect final text for every iteration; last non-empty wins.
    const textPieces = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .filter((s) => s.trim().length > 0);
    if (textPieces.length) finalText = textPieces.join("\n").trim();

    stop_reason = resp.stop_reason;

    if (resp.stop_reason === "end_turn") break;
    if (resp.stop_reason !== "tool_use") {
      console.error(`[gate7] unexpected stop_reason=${resp.stop_reason}; aborting loop`);
      break;
    }

    // Append assistant turn (preserves thinking / tool_use blocks for next round).
    messages.push({ role: "assistant", content: resp.content });

    // Resolve every tool_use in the assistant turn.
    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      console.log(
        `[gate7]   tool_use ${call.name}(${JSON.stringify(call.input).slice(0, 120)})`
      );
      const result = await callWeavoryTool(
        mcp,
        call.name,
        call.input as Record<string, unknown>
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: result.text || "(empty)",
        is_error: result.ok ? undefined : true,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  console.log("\n[gate7] --- final answer ---");
  console.log(finalText || "(no final text produced)");

  const normalized = finalText.toLowerCase();
  const containsCongested = normalized.includes("congested");
  const contains14 = /\b14\b/.test(normalized);
  console.log(
    `[gate7] answer contains 'congested': ${containsCongested}; contains '14': ${contains14};` +
      ` iterations used: ${iterations}; last stop_reason: ${stop_reason}`
  );

  if (!containsCongested || !contains14) {
    console.error("[gate7] ✗ scripted answer not produced");
    process.exit(1);
  }

  console.log("[gate7] ✓ Gate 7 simulation: stock agent completed the task using only the README.");
}

main().catch((err) => {
  console.error("[gate7] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
