// VeriBib server: static site + JSON/NDJSON verification API. Zero dependencies.
//
//   PORT=3847 CONTACT_EMAIL=you@example.org OPENALEX_API_KEY=... node server.js
//
// The same engine (public/lib) also runs in the browser, so the site works on
// static hosting; the server adds full web-page inspection (no CORS limits).

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { auditBibliography, configure, prepare, summarize, MAX_ENTRIES } from "./public/lib/audit.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 3847;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = 1024 * 1024;
const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")).version;

configure({ mailto: process.env.CONTACT_EMAIL, openalexKey: process.env.OPENALEX_API_KEY });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|manifest)|image\/svg)/;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// --- tiny per-IP rate limiter for the API --------------------------------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return list.length > 20;
}

function send(req, res, status, body, headers = {}) {
  const type = headers["Content-Type"] || "application/octet-stream";
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { ...SECURITY_HEADERS, ...headers, Vary: "Accept-Encoding" };
  if (payload.length > 1024 && COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    payload = zlib.gzipSync(payload);
    h["Content-Encoding"] = "gzip";
  }
  h["Content-Length"] = payload.length;
  res.writeHead(status, h);
  res.end(req.method === "HEAD" ? undefined : payload);
}

function sendJson(req, res, status, data) {
  send(req, res, status, JSON.stringify(data), { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY * 8) return req.destroy(); // abusive upload: stop reading
      if (size > MAX_BODY) {
        if (!tooLarge) reject(Object.assign(new Error("Request body too large (max 1 MB)"), { status: 413 }));
        tooLarge = true;
        chunks.length = 0; // keep draining so the client can read the 413
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleVerify(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (rateLimited(ip)) return sendJson(req, res, 429, { error: "Too many audits. Please wait a minute." });

  let text;
  try {
    const raw = await readBody(req);
    const type = req.headers["content-type"] || "";
    text = /json/.test(type) ? JSON.parse(raw || "{}").text : raw;
  } catch (err) {
    if (err.status === 413) res.setHeader("Connection", "close");
    return sendJson(req, res, err.status || 400, { error: err.status ? err.message : "Body must be JSON: {\"text\": \"...\"}" });
  }
  if (typeof text !== "string" || !text.trim()) return sendJson(req, res, 400, { error: "No bibliography text provided." });
  if (!prepare(text).entries.length) return sendJson(req, res, 422, { error: "No references detected in the text." });

  const controller = new AbortController();
  res.on("close", () => !res.writableEnded && controller.abort());
  const url = new URL(req.url, "http://x");
  const stream = url.searchParams.has("stream") || /ndjson/.test(req.headers.accept || "");

  if (!stream) {
    try {
      const out = await auditBibliography(text, { signal: controller.signal });
      return sendJson(req, res, 200, out);
    } catch (err) {
      if (controller.signal.aborted) return;
      return sendJson(req, res, 500, { error: err.message });
    }
  }

  // NDJSON stream: one line per event so the UI can render results as they land.
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const write = (obj) => !res.writableEnded && res.write(`${JSON.stringify(obj)}\n`);
  const started = Date.now();
  const results = [];
  try {
    await auditBibliography(text, {
      signal: controller.signal,
      onStart: (info) => write({ type: "start", ...info }),
      onResult: (r) => {
        results.push(r);
        write({ type: "result", result: r });
      },
    });
    write({ type: "done", summary: summarize(results, started) });
  } catch (err) {
    write({ type: "error", error: err.message });
  }
  res.end();
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(req, res, 400, "Bad request", { "Content-Type": MIME[".txt"] });
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(rel)}`);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(req, res, 403, "Forbidden", { "Content-Type": MIME[".txt"] });

  try {
    let target = file;
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) target = path.join(target, "index.html");
    const body = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const cache = ext === ".html" || ext === ".webmanifest" ? "no-cache" : /\/lib\/|\.js$|\.css$/.test(target) ? "public, max-age=300" : "public, max-age=86400";
    return send(req, res, 200, body, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache });
  } catch {
    const notFound = await fs.readFile(path.join(PUBLIC_DIR, "404.html")).catch(() => Buffer.from("Not found"));
    return send(req, res, 404, notFound, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (pathname === "/api/health") return sendJson(req, res, 200, { ok: true, engine: "server", version: VERSION, maxEntries: MAX_ENTRIES });
    if (pathname === "/api/verify") {
      if (req.method !== "POST") return sendJson(req, res, 405, { error: "Use POST with {\"text\": \"...\"}" });
      return await handleVerify(req, res);
    }
    if (pathname.startsWith("/api/")) return sendJson(req, res, 404, { error: "Unknown endpoint" });
    if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "Method not allowed", { "Content-Type": MIME[".txt"] });
    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(req, res, 500, { error: "Internal server error" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`VeriBib ${VERSION} running at http://localhost:${server.address().port}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
