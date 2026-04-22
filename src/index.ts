/**
 * weavory.ai — public library surface (npm package entry point)
 *
 * The primary way to use weavory is as an MCP server (`weavory start`
 * via the `bin` field, or `runStdio()` programmatically). This module
 * also re-exports the engine primitives, policy hook, persistence
 * factory, incident export/replay, and schema types for embedders
 * who want to drive the engine directly.
 *
 * Everything re-exported here is part of the stable v0.1.x public API.
 * The 5-tool MCP surface (believe, recall, subscribe, attest, forget)
 * is locked by ADR-005; the library re-exports are additive conveniences.
 */

// ─── MCP server ────────────────────────────────────────────────────────
export { createServer, runStdio } from "./mcp/server.js";
export type { CreateServerOptions } from "./mcp/server.js";

// ─── Engine state + mutation ops ───────────────────────────────────────
export {
  EngineState,
  SubscriptionLimitError,
  DEFAULT_MAX_SUBSCRIPTIONS,
  parseSubscriptionsCap,
  subscriptionMatches,
  deriveKeyPair,
} from "./engine/state.js";
export type {
  EngineOp,
  Subscription,
  SubscriptionFilters,
  TrustVector,
} from "./engine/state.js";

export {
  believe,
  recall,
  subscribe,
  attest,
  forget,
  DEFAULT_MAX_OBJECT_BYTES,
  OversizedPayloadError,
} from "./engine/ops.js";
export type {
  BelieveInput,
  BelieveOutput,
  RecallInput,
  RecallOutput,
  SubscribeInput,
  SubscribeOutput,
  AttestInput,
  AttestOutput,
  ForgetInput,
  ForgetOutput,
} from "./engine/ops.js";

// ─── Policy hook ───────────────────────────────────────────────────────
export {
  loadPolicy,
  compile as compilePolicy,
  evaluate as evaluatePolicy,
  PolicyDenialError,
  policyPathFromEnv,
  PolicyFileSchema,
} from "./engine/policy.js";
export type {
  Policy,
  PolicyFile,
  PolicyResult,
  PolicyDenial,
  PolicyAllow,
  BelieveGateInput,
} from "./engine/policy.js";

// ─── Persistence ───────────────────────────────────────────────────────
export {
  openPersistentStore,
  kindFromEnv,
  persistEnabledFromEnv,
  dataDirFromEnv,
} from "./store/persist.js";
export type {
  PersistKind,
  PersistedTrust,
  LoadDiagnostics,
  LoadResult,
  PersistentStore,
  PersistOptions,
} from "./store/persist.js";

// ─── Incident export + replay ──────────────────────────────────────────
export { scanForTamper, exportIncident } from "./engine/incident.js";
export type {
  TamperScanResult,
  IncidentRecord,
  ExportIncidentOptions,
  ExportIncidentResult,
} from "./engine/incident.js";

export { loadIncident, rehydrateState, runReplay } from "./engine/replay.js";
export type {
  LoadedIncident,
  ReplayOptions,
  ReplaySummary,
  ReplayResult,
} from "./engine/replay.js";

// ─── Core types (schema, audit, crypto primitives) ─────────────────────
export {
  SCHEMA_VERSION,
  GENESIS_PREV_HASH,
  BeliefPayloadSchema,
  SignedBeliefSchema,
  StoredBeliefSchema,
  AuditEntrySchema,
  AuditOperationSchema,
  JsonValueSchema,
} from "./core/schema.js";
export type {
  BeliefPayload,
  SignedBelief,
  StoredBelief,
  AuditEntry,
  AuditOperation,
  JsonValue,
} from "./core/schema.js";

export { AuditStore } from "./store/audit.js";

/** Library version string (matches package.json). */
export const VERSION = "0.1.1" as const;
