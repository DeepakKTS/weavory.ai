/**
 * Tiny static file server for the weavory control dashboard.
 *
 * Serves the repo root so that /ops/weavory-dashboard.html can resolve
 * ../control/*.json and ./data/*.json relatively. No fabricated responses:
 * missing files return 404, which the dashboard renders as "Not collected yet".
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const PORT = Number(process.env.WEAVORY_DASHBOARD_PORT ?? 4317);
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawPath = decodeURIComponent(url.pathname);
    const relPath = rawPath === "/" || rawPath === "" ? DEFAULT_PATH : rawPath;

    // Reject path traversal attempts.
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
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error: " + (err instanceof Error ? err.message : String(err)));
  }
});

server.listen(PORT, () => {
  const origin = `http://localhost:${PORT}`;
  // eslint-disable-next-line no-console
  console.log(`[weavory dashboard] serving ${REPO_ROOT}`);
  // eslint-disable-next-line no-console
  console.log(`[weavory dashboard] open ${origin}${DEFAULT_PATH}`);
});
