/**
 * Unit tests — startup banner safety rails (src/cli.ts).
 *
 * The banner MUST be safe in every context a user could launch the CLI:
 * a real terminal (print it), a piped subprocess like Claude Desktop or
 * the Vitest persistence_subprocess test (stay silent — any byte on the
 * wrong stream corrupts MCP JSON-RPC), and when the operator explicitly
 * opts out via WEAVORY_NO_BANNER=1. These tests exercise all three
 * guards with an injected writer so no actual terminal output is touched.
 */
import { describe, expect, it } from "vitest";
import { printStartupBanner } from "../../src/cli.js";

function captureBanner(opts: {
  isTty: boolean;
  suppressed: boolean;
  version?: string;
}): string {
  let captured = "";
  printStartupBanner({
    version: opts.version ?? "9.9.9",
    writer: (s) => {
      captured += s;
    },
    isTty: opts.isTty,
    suppressed: opts.suppressed,
  });
  return captured;
}

describe("startup banner", () => {
  it("prints when isTty=true and not suppressed", () => {
    const out = captureBanner({ isTty: true, suppressed: false });
    expect(out.length).toBeGreaterThan(0);
  });

  it("is silent when isTty=false (covers piped MCP clients + subprocess tests + CI)", () => {
    const out = captureBanner({ isTty: false, suppressed: false });
    expect(out).toBe("");
  });

  it("is silent when suppressed=true (WEAVORY_NO_BANNER=1) even in a TTY", () => {
    const out = captureBanner({ isTty: true, suppressed: true });
    expect(out).toBe("");
  });

  it("includes the injected version in the subtitle line", () => {
    const out = captureBanner({ isTty: true, suppressed: false, version: "1.2.3" });
    expect(out).toContain("v1.2.3");
  });

  it("renders the 'weavory.ai' wordmark (block glyphs for both W and .ai)", () => {
    const out = captureBanner({ isTty: true, suppressed: false });
    // Spot-check block-drawing characters that uniquely identify the ANSI
    // Shadow figlet output. If the banner constant is ever edited to a
    // different font or text, one of these assertions will flag it.
    expect(out).toContain("███████╗"); // top of E / I columns
    expect(out).toContain("╚███╔███╔╝"); // distinctive W bottom
    expect(out).toContain(" shared-belief MCP server");
    expect(out).toContain("github.com/DeepakKTS/weavory.ai");
    expect(out).toContain("npm @weavory/mcp");
  });

  it("ends with a trailing blank line so subsequent [weavory] logs have air", () => {
    const out = captureBanner({ isTty: true, suppressed: false });
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("does not contain any ANSI escape codes (monochrome by design)", () => {
    const out = captureBanner({ isTty: true, suppressed: false });
    // ESC (0x1b) is the start byte of every ANSI colour/format sequence.
    // Check via character code so no raw control byte appears in this source.
    const ESC = String.fromCharCode(0x1b);
    expect(out.includes(ESC)).toBe(false);
  });
});
