/**
 * weavory.ai — DuckDB persistence adapter (capability stub)
 *
 * This file will gain a full DuckDB-backed implementation of PersistentStore
 * in P0-3.5. Today it is a capability stub: the exported `openDuckdbStore`
 * throws a structured "not yet implemented" error. `openPersistentStore`
 * catches that error and falls back to JSONL, which is exactly the behavior
 * we want when the DuckDB binary is unavailable at runtime — so this stub
 * ships correctly from day one.
 *
 * Do NOT add a hard top-level `import` of `@duckdb/node-api` here. The module
 * must be resolvable via dynamic import only so missing binaries never break
 * startup on platforms where the prebuilt addon isn't distributed.
 */
import type { PersistentStore } from "./persist.js";

export async function openDuckdbStore(_opts: {
  dataDir: string;
  logger: (msg: string) => void;
}): Promise<PersistentStore> {
  throw new Error(
    "DuckDB adapter not yet implemented — this is the stub that ships before P0-3.5. " +
      "Persistence will transparently fall back to JSONL."
  );
}
