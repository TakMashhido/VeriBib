// Smoke test for the HTTP server (static files, API validation). No registry calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let proc;
let base;

before(async () => {
  proc = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: "0", HOST: "127.0.0.1" } });
  base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 8000);
    proc.stdout.on("data", (d) => {
      const m = String(d).match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
  });
});

after(() => proc?.kill());

test("serves the app and assets", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /<h1 id="hero-title">/);
  assert.equal((await fetch(`${base}/lib/parse.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await fetch(`${base}/site.webmanifest`)).status, 200);
});

test("unknown paths get the 404 page and traversal is blocked", async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
});

test("health endpoint reports the server engine", async () => {
  const body = await (await fetch(`${base}/api/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.engine, "server");
});

test("verify validates its input", async () => {
  const post = (body, type = "application/json") => fetch(`${base}/api/verify`, { method: "POST", headers: { "content-type": type }, body });
  assert.equal((await post(JSON.stringify({ text: "" }))).status, 400);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post(JSON.stringify({ text: "   \n  " }))).status, 400);
  assert.equal((await fetch(`${base}/api/verify`)).status, 405);
  assert.equal((await post("x".repeat(1024 * 1024 + 10), "text/plain")).status, 413);
});
