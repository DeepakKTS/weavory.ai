/**
 * Dashboard sidecar (Phase N.2 · v0.1.16).
 *
 * Serves the weavory control dashboard AND exposes a read-only SSE stream +
 * snapshot / replay API for the live demo dashboard (Phase N.3). This is a
 * sidecar process — NOT part of the MCP server. The five MCP tools (ADR-005
 * lock) are unchanged.
 *
 * Roles:
 *   1. Static file server — unchanged behavior for the existing truthful
 *      control dashboard at `/ops/weavory-dashboard.html` and its JSON data
 *      sources under `control/` + `ops/data/`.
 *   2. Live demo host — an in-process EngineState receives beliefs / attests
 *      / forgets via any in-process driver (tests or a future N.3b demo
 *      button). `state.onEvent` (Phase N.1) fans events to a 200-entry ring
 *      buffer; connected SSE clients tail the buffer.
 *
 * Security posture (read-only; localhost default):
 *   - Binds `127.0.0.1` by default. Override via `WEAVORY_DASHBOARD_BIND=<ip:port>`
 *     or legacy `WEAVORY_DASHBOARD_PORT`.
 *   - When bound non-loopback, EVERY endpoint (SSE included) requires
 *     `?token=<WEAVORY_DASHBOARD_TOKEN>` — EventSource cannot set headers,
 *     so query-string auth is the browser path. Tokens compared with
 *     `crypto.timingSafeEqual`.
 *   - CORS: the legacy `access-control-allow-origin: *` is preserved ONLY
 *     for the static file routes (backwards compat for existing truthful
 *     dashboard tooling). The new API + SSE routes restrict CORS to the
 *     sidecar's own origin or `WEAVORY_DASHBOARD_ALLOWED_ORIGIN`.
 *   - CSP on HTML responses: `default-src 'self'; script-src 'self'; style-src
 *     'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';
 *     object-src 'none'; frame-ancestors 'none'; base-uri 'none'`.
 *   - No write endpoints to the engine. `POST /api/replay` is a thin wrapper
 *     over `ops.recall({as_of, ...})` with `top_k` hard-capped at 50 server-side.
 *   - Rate limits: max 10 concurrent SSE (global); 5-min idle close per
 *     connection; per-IP new-SSE rate cap 1 per second; `/api/replay` 10 req/s
 *     global.
 *   - Log-leak: logs only a TOKEN PREFIX (first 6 chars), never the full token
 *     or any private material from engine state.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { EngineState } from "../src/engine/state.js";
import type { StreamEvent } from "../src/engine/stream_event.js";
import { recall } from "../src/engine/ops.js";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_PATH = "/ops/weavory-dashboard.html";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const CSP_HEADER =
  // Strict by default. Connect / script / frame / object locked to 'self' so
  // an XSS payload can't exfiltrate the SSE stream or execute remote code;
  // Google Fonts is the only external origin allowed (matches the docs-site
  // landing page so the two dashboards share their Geist+Geist Mono look).
  "default-src 'self'; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
  "frame-ancestors 'none'; base-uri 'none'";

/** Circular ring buffer of StreamEvents with monotonic event ids (for SSE
 *  `id:` frames + `Last-Event-ID` resume). O(1) append; O(N) `since()` read
 *  which is bounded by the cap (200). */
export class StreamRingBuffer {
  readonly capacity: number;
  private buf: Array<{ id: number; event: StreamEvent }> = [];
  private nextId = 1;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  push(event: StreamEvent): number {
    const id = this.nextId++;
    this.buf.push({ id, event });
    if (this.buf.length > this.capacity) this.buf.shift();
    return id;
  }

  /** Return entries with id strictly greater than `afterId`. */
  since(afterId: number): Array<{ id: number; event: StreamEvent }> {
    return this.buf.filter((e) => e.id > afterId);
  }

  /** Snapshot the buffer (for /api/state use). */
  snapshot(): Array<{ id: number; event: StreamEvent }> {
    return this.buf.slice();
  }

  get lastId(): number {
    return this.nextId - 1;
  }
}

// ─── SSE client bookkeeping ──────────────────────────────────────────────

interface SseClient {
  res: ServerResponse;
  ip: string;
  connectedAt: number;
  idleTimer: NodeJS.Timeout | null;
}

const SSE_MAX_CONCURRENT = 10;
const SSE_IDLE_MS = 5 * 60 * 1000;
const SSE_PER_IP_MIN_INTERVAL_MS_DEFAULT = 1000;
const REPLAY_MAX_PER_SEC = 10;

// ─── Public factory ──────────────────────────────────────────────────────

export interface DashboardSidecarOptions {
  /** Host:port string, e.g. "127.0.0.1:4317". Takes precedence over bindHost/port. */
  bind?: string;
  bindHost?: string;
  port?: number;
  /** When the sidecar is bound non-loopback, require `?token=` match on all routes. */
  token?: string;
  /** Exact origin to allow cross-origin requests from (in addition to same-origin). */
  allowedOrigin?: string;
  /** Supply a pre-constructed state (for tests or for composing with another driver). */
  state?: EngineState;
  /** Silence the banner log (tests). */
  quiet?: boolean;
  /** Override the per-IP SSE-reconnect interval (ms). Default 1000. Tests may
   *  set to 0 to exercise the concurrency cap without waiting out the rate limit. */
  perIpMinIntervalMs?: number;
}

export interface DashboardSidecarHandle {
  state: EngineState;
  server: Server;
  ring: StreamRingBuffer;
  address: { host: string; port: number };
  /** Current SSE client count — tests and `/api/state` read this. */
  sseClientCount(): number;
  close(): Promise<void>;
}

function parseBind(opts: DashboardSidecarOptions): { host: string; port: number } {
  const rawBind = opts.bind ?? process.env.WEAVORY_DASHBOARD_BIND ?? "";
  if (rawBind.length > 0) {
    const idx = rawBind.lastIndexOf(":");
    if (idx > 0) {
      const h = rawBind.slice(0, idx);
      const p = Number(rawBind.slice(idx + 1));
      if (Number.isInteger(p) && p > 0) return { host: h, port: p };
    }
  }
  const host = opts.bindHost ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.WEAVORY_DASHBOARD_PORT ?? 4317);
  return { host, port };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function requireAuth(host: string): boolean {
  return !isLoopback(host);
}

/** Constant-time comparison of two strings. Returns false if lengths differ. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function startDashboardSidecar(
  opts: DashboardSidecarOptions = {}
): Promise<DashboardSidecarHandle> {
  const { host, port } = parseBind(opts);
  const authRequired = requireAuth(host);
  const token = opts.token ?? process.env.WEAVORY_DASHBOARD_TOKEN ?? "";
  if (authRequired && token.length === 0) {
    throw new Error(
      "[dashboard] bind is non-loopback but WEAVORY_DASHBOARD_TOKEN is unset. " +
        "Refusing to start without auth."
    );
  }

  const state = opts.state ?? new EngineState();
  const ring = new StreamRingBuffer(200);
  const sseClients = new Set<SseClient>();
  const lastConnectByIp = new Map<string, number>();
  const replayTimestamps: number[] = []; // sliding-window for /api/replay rate

  const allowedOrigin =
    opts.allowedOrigin ?? process.env.WEAVORY_DASHBOARD_ALLOWED_ORIGIN ?? `http://${host}:${port}`;
  const perIpMinIntervalMs =
    opts.perIpMinIntervalMs ?? SSE_PER_IP_MIN_INTERVAL_MS_DEFAULT;

  state.onEvent = (event): void => {
    const id = ring.push(event);
    const frame = formatSseFrame(id, event);
    for (const c of sseClients) {
      try {
        c.res.write(frame);
        // Reset idle timer on each write.
        if (c.idleTimer) clearTimeout(c.idleTimer);
        c.idleTimer = setTimeout(() => {
          try {
            c.res.end();
          } catch {
            /* noop */
          }
          sseClients.delete(c);
        }, SSE_IDLE_MS);
      } catch {
        sseClients.delete(c);
      }
    }
  };

  function authOk(url: URL, req: IncomingMessage): boolean {
    if (!authRequired) return true;
    const qs = url.searchParams.get("token") ?? "";
    if (qs.length > 0 && constantTimeEquals(qs, token)) return true;
    const header = req.headers["x-weavory-token"];
    if (typeof header === "string" && constantTimeEquals(header, token)) return true;
    return false;
  }

  function setCorsFor(url: URL, req: IncomingMessage, res: ServerResponse, apiRoute: boolean): void {
    if (apiRoute) {
      const origin = req.headers.origin;
      if (typeof origin === "string" && origin === allowedOrigin) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
      }
      // No `*` fallback on API routes — CORS is opt-in per origin.
    } else {
      // Static routes keep the legacy permissive CORS so existing truthful-dashboard
      // tooling (other localhost pages curling control/*.json) continues to work.
      res.setHeader("access-control-allow-origin", "*");
    }
  }

  // ─── Handlers ──────────────────────────────────────────────────────────

  async function handleStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const rawPath = decodeURIComponent(url.pathname);
    const relPath = rawPath === "/" || rawPath === "" ? DEFAULT_PATH : rawPath;
    const resolved = resolve(join(REPO_ROOT, relPath));
    if (!resolved.startsWith(REPO_ROOT)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const info = await stat(resolved).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const body = await readFile(resolved);
    const type = MIME[extname(resolved).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": "no-store",
    };
    if (type.startsWith("text/html")) headers["content-security-policy"] = CSP_HEADER;
    res.writeHead(200, headers);
    res.end(body);
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    // Global concurrency cap.
    if (sseClients.size >= SSE_MAX_CONCURRENT) {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("too many sse clients");
      return;
    }

    // Per-IP connection-rate cap.
    const ip = req.socket.remoteAddress ?? "unknown";
    const last = lastConnectByIp.get(ip) ?? 0;
    const nowMs = Date.now();
    if (perIpMinIntervalMs > 0 && nowMs - last < perIpMinIntervalMs) {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("reconnect rate limited");
      return;
    }
    lastConnectByIp.set(ip, nowMs);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    });

    // Resume from Last-Event-ID if present.
    const resume = Number(req.headers["last-event-id"] ?? 0);
    const replay = Number.isFinite(resume) && resume > 0 ? ring.since(resume) : ring.snapshot();
    for (const { id, event } of replay) {
      res.write(formatSseFrame(id, event));
    }
    // Tell the browser how to reconnect (5 s).
    res.write("retry: 5000\n\n");

    const client: SseClient = {
      res,
      ip,
      connectedAt: nowMs,
      idleTimer: setTimeout(() => {
        try {
          res.end();
        } catch {
          /* noop */
        }
        sseClients.delete(client);
      }, SSE_IDLE_MS),
    };
    sseClients.add(client);

    req.on("close", () => {
      if (client.idleTimer) clearTimeout(client.idleTimer);
      sseClients.delete(client);
    });
  }

  function handleApiState(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    // Branch 1: belief lookup by id prefix (for the causality chain panel).
    const prefix = url.searchParams.get("belief_id");
    if (prefix && /^[0-9a-f]{4,64}$/.test(prefix)) {
      const match = findBeliefByPrefix(state, prefix);
      if (!match) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found", prefix }));
        return;
      }
      // Resolve causes[] to their subject/predicate so the UI can draw a tree
      // without a second round-trip per parent.
      const causes = (match.causes ?? []).map((cid) => {
        const c = state.beliefs.get(cid);
        if (!c) return { id_prefix: cid.slice(0, 16), subject: null, predicate: null };
        return { id_prefix: c.id.slice(0, 16), subject: c.subject, predicate: c.predicate };
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          belief: {
            id_prefix: match.id.slice(0, 16),
            subject: match.subject,
            predicate: match.predicate,
            object: match.object,
            confidence: match.confidence,
            signer_short: match.signer_id.slice(0, 12),
            ingested_at: match.ingested_at,
            invalidated_at: match.invalidated_at,
            quarantined: match.quarantined,
          },
          causes,
        })
      );
      return;
    }

    // Branch 2: histogram of belief timestamps (for the time scrubber stops).
    if (url.searchParams.get("histogram") === "1") {
      const buckets = buildHistogram(state);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(buckets));
      return;
    }

    // Branch 3: default — snapshot.
    let beliefs_live = 0;
    let quarantine_count = 0;
    const trust_graph: Record<string, Record<string, number>> = {};
    let oldestIngestedAt: string | null = null;
    let newestIngestedAt: string | null = null;
    for (const b of state.beliefs.values()) {
      if (!b.invalidated_at) beliefs_live++;
      if (b.quarantined) quarantine_count++;
      if (oldestIngestedAt === null || b.ingested_at < oldestIngestedAt) oldestIngestedAt = b.ingested_at;
      if (newestIngestedAt === null || b.ingested_at > newestIngestedAt) newestIngestedAt = b.ingested_at;
    }
    for (const [signer, vec] of state.trust) {
      const short = signer.slice(0, 12);
      const row: Record<string, number> = {};
      for (const [topic, score] of vec) row[topic] = score;
      trust_graph[short] = row;
    }
    const subscriptions = [] as Array<{
      id: string;
      pattern: string;
      queue_depth: number;
      dropped_count: number;
      matches_since_created: number;
      signer_short: string | null;
    }>;
    for (const sub of state.subscriptions.values()) {
      subscriptions.push({
        id: sub.id,
        pattern: sub.pattern,
        queue_depth: sub.queue.length,
        dropped_count: sub.dropped_count,
        matches_since_created: sub.matches_since_created,
        signer_short: sub.signer_id ? sub.signer_id.slice(0, 12) : null,
      });
    }
    const body = JSON.stringify({
      beliefs_total: state.beliefs.size,
      beliefs_live,
      quarantine_count,
      audit_length: state.audit.length(),
      active_subscriptions: state.subscriptions.size,
      sse_clients: sseClients.size,
      last_event_id: ring.lastId,
      oldest_ingested_at: oldestIngestedAt,
      newest_ingested_at: newestIngestedAt,
      trust_graph,
      subscriptions,
    });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }

  async function handleApiReplay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("POST only");
      return;
    }
    // Global sliding-window rate limit (1s window).
    const nowMs = Date.now();
    while (replayTimestamps.length > 0 && nowMs - replayTimestamps[0]! > 1000) {
      replayTimestamps.shift();
    }
    if (replayTimestamps.length >= REPLAY_MAX_PER_SEC) {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("replay rate limited");
      return;
    }
    replayTimestamps.push(nowMs);

    const raw = await readBody(req, 16 * 1024);
    let parsed: {
      query?: string;
      as_of?: string | null;
      filters?: { subject?: string; predicate?: string; min_confidence?: number };
      min_trust?: number;
      include_quarantined?: boolean;
      include_tombstoned?: boolean;
      top_k?: number;
    } = {};
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad json");
      return;
    }
    const top_k = Math.min(50, Math.max(1, parsed.top_k ?? 20));
    const out = recall(state, {
      query: parsed.query ?? "",
      top_k,
      ...(parsed.as_of !== undefined ? { as_of: parsed.as_of } : {}),
      ...(parsed.min_trust !== undefined ? { min_trust: parsed.min_trust } : {}),
      ...(parsed.filters !== undefined ? { filters: parsed.filters } : {}),
      ...(parsed.include_quarantined !== undefined
        ? { include_quarantined: parsed.include_quarantined }
        : {}),
      ...(parsed.include_tombstoned !== undefined
        ? { include_tombstoned: parsed.include_tombstoned }
        : {}),
    });
    // Strip signatures from replay output — UI doesn't need the 128-hex
    // signatures and shipping them just increases payload size.
    const trimmed = out.beliefs.map((b) => ({
      id_prefix: b.id.slice(0, 16),
      subject: b.subject,
      predicate: b.predicate,
      object: b.object,
      confidence: b.confidence,
      signer_short: b.signer_id.slice(0, 12),
      ingested_at: b.ingested_at,
      invalidated_at: b.invalidated_at,
      quarantined: b.quarantined,
    }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ beliefs: trimmed, total_matched: out.total_matched, now: out.now }));
  }

  // ─── HTTP server ──────────────────────────────────────────────────────

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const path = url.pathname;
      const isApiOrSse =
        path === "/events" || path === "/api/state" || path === "/api/replay";

      // Preflight CORS for API routes.
      if (req.method === "OPTIONS" && isApiOrSse) {
        setCorsFor(url, req, res, true);
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, x-weavory-token");
        res.writeHead(204);
        res.end();
        return;
      }

      setCorsFor(url, req, res, isApiOrSse);

      if (isApiOrSse && !authOk(url, req)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("unauthorized");
        return;
      }

      if (path === "/events") {
        handleEvents(req, res);
        return;
      }
      if (path === "/api/state") {
        handleApiState(req, res, url);
        return;
      }
      if (path === "/api/replay") {
        await handleApiReplay(req, res);
        return;
      }
      await handleStatic(req, res, url);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error: " + (err instanceof Error ? err.message : String(err)));
    }
  });

  await new Promise<void>((resolveP) => server.listen(port, host, resolveP));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  if (!opts.quiet) {
    const origin = `http://${host}:${actualPort}`;
    const tokenNote = authRequired
      ? ` (auth required — token prefix=${token.slice(0, 6)}…)`
      : "";
    process.stdout.write(`[weavory dashboard] serving ${REPO_ROOT}\n`);
    process.stdout.write(`[weavory dashboard] open  ${origin}${DEFAULT_PATH}\n`);
    process.stdout.write(`[weavory dashboard] SSE   ${origin}/events${tokenNote}\n`);
  }

  return {
    state,
    server,
    ring,
    address: { host, port: actualPort },
    sseClientCount: () => sseClients.size,
    close: async (): Promise<void> => {
      for (const c of sseClients) {
        if (c.idleTimer) clearTimeout(c.idleTimer);
        try {
          c.res.end();
        } catch {
          /* noop */
        }
      }
      sseClients.clear();
      state.onEvent = undefined;
      await new Promise<void>((resolveP, rejectP) =>
        server.close((err) => (err ? rejectP(err) : resolveP()))
      );
    },
  };
}

function formatSseFrame(id: number, event: StreamEvent): string {
  // SSE frames MUST end with a blank line. `id:` enables `Last-Event-ID` resume.
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Locate a belief by its id prefix (client only knows the first 16 hex). */
function findBeliefByPrefix(
  state: EngineState,
  prefix: string
): import("../src/core/schema.js").StoredBelief | null {
  for (const b of state.beliefs.values()) {
    if (b.id.startsWith(prefix)) return b;
  }
  return null;
}

/** Build a simple time histogram for the scrubber — evenly-spaced buckets
 *  over the belief timeline, each carrying {ingested_at ISO, count}. */
function buildHistogram(
  state: EngineState
): { bucket_count: number; buckets: Array<{ t: string; n: number }> } {
  const timestamps: number[] = [];
  for (const b of state.beliefs.values()) {
    const ms = Date.parse(b.ingested_at);
    if (Number.isFinite(ms)) timestamps.push(ms);
  }
  if (timestamps.length === 0) {
    return { bucket_count: 0, buckets: [] };
  }
  timestamps.sort((a, b) => a - b);
  const first = timestamps[0]!;
  const last = timestamps[timestamps.length - 1]!;
  const span = Math.max(1, last - first);
  const bucketCount = Math.min(40, Math.max(1, timestamps.length));
  const bucketSize = span / bucketCount;
  const buckets: Array<{ t: string; n: number }> = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = first + i * bucketSize;
    const hi = i === bucketCount - 1 ? last + 1 : first + (i + 1) * bucketSize;
    let n = 0;
    for (const t of timestamps) if (t >= lo && t < hi) n++;
    buckets.push({ t: new Date(lo).toISOString(), n });
  }
  return { bucket_count: bucketCount, buckets };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectP(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveP(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectP);
  });
}

// ─── CLI entry point ──────────────────────────────────────────────────────

const isCliEntry = (() => {
  try {
    const self = import.meta.url;
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return self === new URL(argv1, "file://").href || self.endsWith(argv1);
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  startDashboardSidecar().catch((err) => {
    process.stderr.write(`[weavory dashboard] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
