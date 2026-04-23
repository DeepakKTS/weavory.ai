/**
 * Integration tests — MCP surface (Gate 2 prerequisite).
 *
 * Uses the SDK's InMemoryTransport to wire a Client ⇄ Server pair in-process.
 * Exercises all five tools for schema compliance and happy-path round trips.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";

const EXPECTED_TOOLS = [
  "weavory_believe",
  "weavory_recall",
  "weavory_subscribe",
  "weavory_attest",
  "weavory_forget",
] as const;

async function wire() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const { server } = createServer();
  await server.connect(serverT);
  const client = new Client({ name: "weavory-test-client", version: "0.0.0" });
  await client.connect(clientT);
  return { client };
}

describe("MCP surface (T-M-001..T-M-003, Gate 2)", () => {
  let client: Client;
  beforeAll(async () => {
    ({ client } = await wire());
  });

  it("lists exactly the five declared tools (T-M-001)", async () => {
    const r = await client.listTools();
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("believe happy path returns a structured id + audit info", async () => {
    const r = await client.callTool({
      name: "weavory_believe",
      arguments: {
        subject: "s",
        predicate: "p",
        object: "o",
        signer_seed: "alice-mcp",
      },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toBeDefined();
    const sc = r.structuredContent as { id: string; signer_id: string; audit_length: number };
    expect(sc.id).toMatch(/^[0-9a-f]{64}$/);
    expect(sc.signer_id).toMatch(/^[0-9a-f]{64}$/);
    expect(sc.audit_length).toBeGreaterThanOrEqual(1);
  });

  it("believe rejects malformed args with a structured error (T-M-002)", async () => {
    const r = await client.callTool({
      name: "weavory_believe",
      arguments: {
        // missing `subject`
        predicate: "p",
        object: "o",
      },
    });
    expect(r.isError).toBe(true);
  });

  it("recall happy path returns a beliefs array", async () => {
    // Write something first so recall has content.
    await client.callTool({
      name: "weavory_believe",
      arguments: {
        subject: "mcp:test:subject",
        predicate: "states",
        object: "hello",
        signer_seed: "alice-mcp",
      },
    });
    // Raise trust so default min_trust doesn't filter it.
    await client.callTool({
      name: "weavory_attest",
      arguments: {
        signer_id: "0".repeat(64), // attesting the wrong id is harmless; we trust default
        topic: "states",
        score: 0.9,
      },
    });

    const r = await client.callTool({
      name: "weavory_recall",
      arguments: { query: "mcp", top_k: 5 },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { beliefs: unknown[]; total_matched: number; now: string };
    expect(Array.isArray(sc.beliefs)).toBe(true);
    expect(sc.total_matched).toBeGreaterThanOrEqual(1);
    expect(sc.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("subscribe returns a subscription_id", async () => {
    const r = await client.callTool({
      name: "weavory_subscribe",
      arguments: { pattern: "market:*" },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { subscription_id: string; created_at: string };
    expect(sc.subscription_id).toMatch(/^sub_[0-9a-f]+$/);
  });

  it("attest returns the clamped score and an entry_hash", async () => {
    const r = await client.callTool({
      name: "weavory_attest",
      arguments: {
        signer_id: "a".repeat(64),
        topic: "knows",
        score: 0.75,
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { applied_score: number; entry_hash: string };
    expect(sc.applied_score).toBeCloseTo(0.75);
    expect(sc.entry_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forget on an unknown id reports found=false", async () => {
    const r = await client.callTool({
      name: "weavory_forget",
      arguments: { belief_id: "0".repeat(64) },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { found: boolean };
    expect(sc.found).toBe(false);
  });
});
