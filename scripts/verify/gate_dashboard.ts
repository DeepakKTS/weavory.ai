/**
 * Gate: dashboard SSE sidecar (Phase N.2 · v0.1.16).
 *
 * Boots `startDashboardSidecar` on an ephemeral localhost port and asserts:
 *   1. SSE clients receive correctly-framed JSON events when an op fires on
 *      the in-process engine.
 *   2. CSP + CORS + cache headers are set correctly on the static HTML route.
 *   3. Non-loopback bind requires a `?token=` auth query parameter.
 *   4. The 11th concurrent SSE connection is refused with HTTP 429.
 *   5. `POST /api/replay` clamps `top_k` to 50 even when the client requests
 *      more.
 */
import { believe } from "../../src/engine/ops.js";
import { startDashboardSidecar, type DashboardSidecarHandle } from "../serve-dashboard.js";

const ok = (msg: string): void => process.stdout.write(`  [32m✓[0m ${msg}\n`);
const bad = (msg: string): never => {
  process.stderr.write(`  [31m✗[0m ${msg}\n`);
  process.exit(1);
};

async function withSidecar<T>(
  opts: Parameters<typeof startDashboardSidecar>[0],
  fn: (h: DashboardSidecarHandle) => Promise<T>
): Promise<T> {
  const h = await startDashboardSidecar({ quiet: true, ...opts });
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal SSE reader over fetch + ReadableStream. Returns the first N frames. */
async function readSseFrames(
  baseUrl: string,
  maxFrames: number,
  timeoutMs = 5000,
  token?: string
): Promise<Array<{ id: string; data: string }>> {
  const url = token ? `${baseUrl}/events?token=${encodeURIComponent(token)}` : `${baseUrl}/events`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (resp.status !== 200) throw new Error(`/events status ${resp.status}`);
    const body = resp.body;
    if (!body) throw new Error("no body on /events");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const frames: Array<{ id: string; data: string }> = [];
    while (frames.length < maxFrames) {
      const r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        let id = "";
        const dataLines: string[] = [];
        for (const line of p.split("\n")) {
          if (line.startsWith("id: ")) id = line.slice(4);
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        if (dataLines.length > 0) frames.push({ id, data: dataLines.join("\n") });
        if (frames.length >= maxFrames) break;
      }
    }
    await reader.cancel().catch(() => {});
    return frames;
  } finally {
    clearTimeout(timer);
  }
}

async function test1_SseFrameShape(): Promise<void> {
  process.stdout.write("[1/5] SSE delivers a correctly-framed event on a live believe()\n");
  await withSidecar({ bindHost: "127.0.0.1", port: 0 }, async (h) => {
    const base = `http://${h.address.host}:${h.address.port}`;
    // Start the SSE reader; the first frame will arrive AFTER the believe() below.
    const framesP = readSseFrames(base, 1);
    // Tiny delay to let the SSE connection register.
    await sleep(50);
    const out = believe(h.state, {
      subject: "demo/gate_dashboard",
      predicate: "status",
      object: { ok: true },
      signer_seed: "alice",
    });
    const frames = await framesP;
    if (frames.length === 0) bad("no SSE frames received");
    const f = frames[0]!;
    if (!/^\d+$/.test(f.id)) bad(`bad SSE id format: ${f.id}`);
    const parsed: unknown = JSON.parse(f.data);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { kind: string }).kind !== "believe"
    ) {
      bad(`first frame kind wrong: ${JSON.stringify(parsed)}`);
    }
    if (out.id.slice(0, 16) !== (parsed as { belief_id_prefix: string }).belief_id_prefix) {
      bad("belief_id_prefix does not match ops.believe() output");
    }
    ok("SSE frame shape OK, kind=believe, belief_id_prefix matches");
  });
}

async function test2_CspCorsHeaders(): Promise<void> {
  process.stdout.write("[2/5] CSP + CORS + cache headers on the static HTML route\n");
  await withSidecar({ bindHost: "127.0.0.1", port: 0 }, async (h) => {
    const base = `http://${h.address.host}:${h.address.port}`;
    const r = await fetch(`${base}/ops/weavory-dashboard.html`);
    if (r.status !== 200) bad(`status ${r.status} for dashboard HTML`);
    const csp = r.headers.get("content-security-policy") ?? "";
    if (!csp.includes("default-src 'self'")) bad(`missing default-src 'self' in CSP: ${csp}`);
    if (!csp.includes("connect-src 'self'")) bad(`missing connect-src 'self' in CSP: ${csp}`);
    if (!csp.includes("frame-ancestors 'none'")) bad(`missing frame-ancestors 'none' in CSP`);
    if (r.headers.get("cache-control") !== "no-store") bad("cache-control not no-store");
    // Static CORS stays permissive for backwards-compat with existing truthful dashboard tooling.
    if (r.headers.get("access-control-allow-origin") !== "*") {
      bad("static route CORS changed from *; would break legacy truthful-dashboard tooling");
    }
    ok("static route CSP + cache + legacy CORS OK");

    // API route CORS should NOT use `*`.
    const apiR = await fetch(`${base}/api/state`, { headers: { origin: "http://evil.example" } });
    if (apiR.headers.get("access-control-allow-origin") === "*") {
      bad("API route CORS has wildcard; expected exact-origin or absent");
    }
    ok("API route CORS is not wildcard");
  });
}

async function test3_AuthRequiredNonLoopback(): Promise<void> {
  process.stdout.write("[3/5] Non-loopback bind requires ?token= auth\n");
  // Bind to 0.0.0.0 (non-loopback) with a fixed token.
  await withSidecar({ bindHost: "0.0.0.0", port: 0, token: "secret-xyz-1234567890" }, async (h) => {
    const base = `http://127.0.0.1:${h.address.port}`;
    const r1 = await fetch(`${base}/api/state`);
    if (r1.status !== 401) bad(`expected 401 on unauthenticated /api/state, got ${r1.status}`);
    ok("unauthenticated /api/state → 401");
    const r2 = await fetch(`${base}/api/state?token=secret-xyz-1234567890`);
    if (r2.status !== 200) bad(`expected 200 with token, got ${r2.status}`);
    ok("authenticated /api/state → 200");
    const r3 = await fetch(`${base}/api/state`, { headers: { "x-weavory-token": "secret-xyz-1234567890" } });
    if (r3.status !== 200) bad(`expected 200 with header token, got ${r3.status}`);
    ok("X-Weavory-Token header auth → 200");
  });
}

async function test4_SseConcurrencyCap(): Promise<void> {
  process.stdout.write("[4/5] 11th concurrent SSE connection → HTTP 429\n");
  // Disable the per-IP rate limit so the test isolates the concurrency cap.
  await withSidecar({ bindHost: "127.0.0.1", port: 0, perIpMinIntervalMs: 0 }, async (h) => {
    const base = `http://${h.address.host}:${h.address.port}`;
    const controllers: AbortController[] = [];
    const openOne = (): Promise<Response> => {
      const c = new AbortController();
      controllers.push(c);
      return fetch(`${base}/events`, { signal: c.signal });
    };
    try {
      const accepted = await Promise.all(Array.from({ length: 10 }, openOne));
      for (const r of accepted) {
        if (r.status !== 200) bad(`expected 200 on 10 concurrent SSE; got ${r.status}`);
      }
      const r11 = await openOne();
      if (r11.status !== 429) bad(`expected 429 on 11th SSE; got ${r11.status}`);
      ok("11th SSE refused with 429 (concurrency cap)");
    } finally {
      for (const c of controllers) c.abort();
    }
  });

  // Separately verify the per-IP rate limit fires when rapid reconnects happen.
  await withSidecar({ bindHost: "127.0.0.1", port: 0 }, async (h) => {
    const base = `http://${h.address.host}:${h.address.port}`;
    const c1 = new AbortController();
    const c2 = new AbortController();
    try {
      const r1 = await fetch(`${base}/events`, { signal: c1.signal });
      if (r1.status !== 200) bad(`first SSE connection rejected: ${r1.status}`);
      const r2 = await fetch(`${base}/events`, { signal: c2.signal });
      if (r2.status !== 429) bad(`expected 429 on second rapid SSE; got ${r2.status}`);
      ok("rapid reconnect from same IP → 429");
    } finally {
      c1.abort();
      c2.abort();
    }
  });
}

async function test5_ReplayTopKClamp(): Promise<void> {
  process.stdout.write("[5/5] POST /api/replay clamps top_k to 50\n");
  await withSidecar({ bindHost: "127.0.0.1", port: 0 }, async (h) => {
    // Seed 60 beliefs so we can verify the clamp actually limits output size.
    for (let i = 0; i < 60; i++) {
      believe(h.state, {
        subject: `demo/clamp/${i}`,
        predicate: "tick",
        object: { i },
        signer_seed: "alice",
      });
    }
    const base = `http://${h.address.host}:${h.address.port}`;
    const r = await fetch(`${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "", top_k: 999 }),
    });
    if (r.status !== 200) bad(`expected 200 on replay, got ${r.status}`);
    const body = (await r.json()) as { beliefs: unknown[]; total_matched: number };
    if (!Array.isArray(body.beliefs)) bad("replay response missing beliefs[]");
    if (body.beliefs.length > 50) bad(`top_k not clamped: got ${body.beliefs.length} beliefs`);
    if (body.total_matched < 60) {
      bad(`total_matched (${body.total_matched}) should reflect ALL 60 beliefs, only beliefs[] is clamped`);
    }
    ok(`top_k clamped to ${body.beliefs.length} ≤ 50 (total_matched=${body.total_matched})`);
  });
}

async function main(): Promise<void> {
  process.stdout.write("Gate dashboard — Phase N.2 SSE sidecar verification\n\n");
  await test1_SseFrameShape();
  process.stdout.write("\n");
  await test2_CspCorsHeaders();
  process.stdout.write("\n");
  await test3_AuthRequiredNonLoopback();
  process.stdout.write("\n");
  await test4_SseConcurrencyCap();
  process.stdout.write("\n");
  await test5_ReplayTopKClamp();
  process.stdout.write("\n[32mGATE DASHBOARD: PASS[0m\n");
}

main().catch((err) => {
  process.stderr.write(`\n[31mGATE DASHBOARD: FAIL[0m ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
