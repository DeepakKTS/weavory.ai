/**
 * Unit test — guards against version-string drift.
 *
 * src/mcp/server.ts hand-maintains `export const VERSION` (string literal,
 * not a runtime readFileSync on package.json) so the module has zero side
 * effects at load time. This test ensures that literal stays in sync with
 * package.json on every release — if someone bumps package.json but forgets
 * the VERSION constant (or vice-versa), CI fails loudly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../../src/mcp/server.js";

describe("version sync", () => {
  it("VERSION constant matches package.json version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
