/**
 * weavory.ai — single source of truth for the package version.
 *
 * Read at runtime from package.json so the banner, the MCP handshake, and
 * anything else that needs the version never drift from the shipped artifact.
 *
 * Works from both `src/core/version.ts` (tsx dev path) and the compiled
 * `dist/core/version.js` (npm/ghcr shipped path); both sit at the same
 * `../../package.json` relative depth.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function computeVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to the unknown-version sentinel.
  }
  return "unknown";
}

/** Shipped package version. Computed once at module load. */
export const VERSION: string = computeVersion();
