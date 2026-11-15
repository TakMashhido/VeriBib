// Zero-dependency Node HTTP server for BibCheck with Claymorphism frontend.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectBibliography, extractFields, splitReferences } from "./lib/parse.js";
import { verifyEntry } from "./lib/verify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3847;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

// Concurrency helper for fast asynchronous verification
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = urlObj.pathname;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API endpoint: POST /api/verify
  if (pathname === "/api/verify" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) req.destroy(); // 2MB limit
    });
    req.on("end", async () => {
      const startTime = Date.now();
      try {
        const data = JSON.parse(body || "{}");
        const rawText = data.text || "";
        if (!rawText.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Empty bibliography text" }));
          return;
        }

        const bibMeta = detectBibliography(rawText);
        const rawEntries = splitReferences(rawText);

        if (!rawEntries.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No valid citation entries detected in text" }));
          return;
        }

        // Process entries concurrently (pool of 4) for high performance
        const results = await mapConcurrent(rawEntries, 4, async (entryText, idx) => {
          const parsed = extractFields(entryText);
          const verification = await verifyEntry(parsed);
          return {
            index: idx + 1,
            raw: entryText,
            parsed,
            verification,
          };
        });

        const verified = results.filter((r) => r.verification.status === "verified").length;
        const needsReview = results.filter((r) => r.verification.status === "needs_review").length;
        const notFound = results.filter((r) => r.verification.status === "not_found").length;
        const total = results.length;
        const avgConfidence = total > 0
          ? Math.round(results.reduce((acc, r) => acc + (r.verification.confidence || 0), 0) / total)
          : 0;

        const summary = {
          total,
          verified,
          needsReview,
          notFound,
          averageConfidence: avgConfidence,
          auditDurationMs: Date.now() - startTime,
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ bibliography: bibMeta, summary, results }, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static files
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`BibCheck server running at http://localhost:${PORT}`);
});
