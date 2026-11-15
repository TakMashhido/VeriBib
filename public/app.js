// VeriBib front end. Uses the Node server when present (streams results and
// inspects web pages fully); otherwise runs the same engine in the browser.

import { splitReferences, detectBibliography } from "./lib/parse.js";

const MAX_ENTRIES = 150;

const SAMPLES = {
  mixed: `[1] Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, L., & Polosukhin, I. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30.
[2] Smith, J. R., & Doe, A. (2023). Quantum supremacy in recursive neural networks with non-abelian gauge fields. Journal of Impossible Physics, 45(2), 112-145. https://doi.org/10.1016/j.fakephys.2023.03.099
[3] He, K., Zhang, X., Ren, S., & Sun, J. (2016). Deep residual learning for image recognition. IEEE Conference on Computer Vision and Pattern Recognition (CVPR), 770-778.
[4] LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436-444. https://doi.org/10.1038/nature14539
[5] Feynman, R. P. (2025). General relativity on quantum silicon wafers. Quantum Computing Letters, 12(4), 300-315.
[6] Johnson, M. (2019). Dropout as a universal regularizer. Nature, 521(7553), 436-444. https://doi.org/10.1145/3065386`,

  ieee: `[1] A. Vaswani et al., "Attention is all you need," in Advances in Neural Information Processing Systems, vol. 30, 2017.
[2] K. He, X. Zhang, S. Ren, and J. Sun, "Deep residual learning for image recognition," in Proc. IEEE Conf. Computer Vision and Pattern Recognition (CVPR), 2016, pp. 770-778.
[3] T. Brown et al., "Language models are few-shot learners," in Advances in Neural Information Processing Systems, vol. 33, 2020, pp. 1877-1901.
[4] L. Martinez and P. Okafor, "Self-correcting transformers for zero-shot protein folding," IEEE Trans. Pattern Anal. Mach. Intell., vol. 46, no. 3, pp. 1201-1215, 2024.`,

  bibtex: `@article{lecun2015deep,
  author  = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  title   = {Deep learning},
  journal = {Nature},
  volume  = {521},
  number  = {7553},
  pages   = {436--444},
  year    = {2015},
  doi     = {10.1038/nature14539}
}

@inproceedings{devlin2019bert,
  author    = {Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina},
  title     = {{BERT}: Pre-training of Deep Bidirectional Transformers for Language Understanding},
  booktitle = {Proceedings of NAACL-HLT},
  pages     = {4171--4186},
  year      = {2019}
}

@misc{radford2021clip,
  author        = {Radford, Alec and Kim, Jong Wook and others},
  title         = {Learning Transferable Visual Models From Natural Language Supervision},
  year          = {2021},
  eprint        = {2103.00020},
  archivePrefix = {arXiv}
}

@article{nonexistent2024,
  author  = {Imaginary, Ada and Fictional, Bo},
  title   = {Superluminal Information Transfer via Neural Entanglement},
  journal = {Journal of Fictional Physics},
  year    = {2024},
  doi     = {10.9999/fake.journal.2024}
}`,

  web: `[1] Weng, L. (2023). LLM-powered autonomous agents. Lil'Log. https://lilianweng.github.io/posts/2023-06-23-agent/
[2] @misc{weng2023prompt,
  author       = {Weng, Lilian},
  title        = {Prompt Engineering},
  howpublished = {\\url{https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/}},
  year         = {2023}
}
[3] Doe, J. (2025). Faster-than-light neural computing. Fictional Blog. https://fake-nonexistent-domain-12345.org/post.html`,

  ids: `10.1038/nature14539
1706.03762
arXiv:2103.00020
https://doi.org/10.1145/3065386
10.1016/j.fakephys.2023.03.099`,
};

const LABELS = { verified: "Verified", needs_review: "Needs review", not_found: "Likely fabricated", pending: "Checking…" };
const ICONS = { verified: "check", needs_review: "alert", not_found: "x", pending: "sparkle" };
const CHECK_ICONS = { pass: "check", warn: "alert", fail: "x", info: "info" };
const FLAG_ICONS = { high: "x", medium: "alert", info: "info" };
const FORMATS = { apa: "APA", ieee: "IEEE", mla: "MLA", bibtex: "BibTeX" };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = {
  input: $("#bibInput"),
  drop: $("#dropZone"),
  file: $("#fileInput"),
  detected: $("#detected"),
  verify: $("#verifyBtn"),
  clear: $("#clearBtn"),
  engine: $("#enginePill"),
  progress: $("#progress"),
  progressText: $("#progressText"),
  progressBar: $("#progressBar"),
  progressFill: $("#progressFill"),
  cancel: $("#cancelBtn"),
  results: $("#results"),
  list: $("#entryList"),
  search: $("#searchInput"),
  toast: $("#toast"),
  theme: $("#themeBtn"),
};

const store = {
  get(k) {
    try {
      return localStorage.getItem(`veribib:${k}`);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(`veribib:${k}`);
      else localStorage.setItem(`veribib:${k}`, v);
    } catch {
      /* storage unavailable */
    }
  },
};

const state = {
  engine: "checking",
  total: 0,
  results: new Map(),
  bibliography: null,
  filter: "all",
  query: "",
  format: FORMATS[store.get("format")] ? store.get("format") : "apa",
  cardFormat: new Map(),
  controller: null,
  startedAt: 0,
  finishedAt: 0,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const icon = (name, cls = "ico") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

let toastTimer;
function toast(msg, kind = "") {
  el.toast.textContent = msg;
  el.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.className = "toast"), kind === "error" ? 4200 : 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* ignore */
    }
    ta.remove();
    return ok;
  }
}

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${name}`);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const chosen = document.documentElement.dataset.theme;
  const resolved = chosen === "light" || chosen === "dark" ? chosen : darkQuery.matches ? "dark" : "light";
  document.documentElement.dataset.resolved = resolved;
  el.theme.setAttribute("aria-label", `Switch to ${resolved === "dark" ? "light" : "dark"} theme`);
}
el.theme.addEventListener("click", () => {
  const next = document.documentElement.dataset.resolved === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("theme", next);
  applyTheme();
});
darkQuery.addEventListener?.("change", applyTheme);
applyTheme();

// ---------------------------------------------------------------------------
// Engine detection
// ---------------------------------------------------------------------------

function setEngine(engine) {
  state.engine = engine;
  el.engine.dataset.engine = engine;
  const map = {
    server: ["server", "Full engine (server)", "Server mode: web pages are opened and inspected."],
    browser: ["browser", "Browser engine", "Static mode: checks run in your browser. Linked pages can only be pinged, not read."],
  };
  const [ico, text, title] = map[engine];
  el.engine.innerHTML = `${icon(ico)}<span>${text}</span>`;
  el.engine.title = title;
}

async function detectEngine() {
  if (location.protocol === "http:" || location.protocol === "https:") {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch("api/health", { cache: "no-store", signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok && (await res.json()).engine === "server") return setEngine("server");
    } catch {
      /* static hosting */
    }
  }
  setEngine("browser");
}

// ---------------------------------------------------------------------------
// Input: samples, files, drafts, live count
// ---------------------------------------------------------------------------

const updateDetected = debounce(() => {
  const text = el.input.value;
  store.set("draft", text.length < 200_000 ? text : null);
  if (!text.trim()) {
    el.detected.textContent = "";
    return;
  }
  const entries = splitReferences(text);
  const { style } = detectBibliography(entries.slice(0, MAX_ENTRIES));
  const n = entries.length;
  const styleName = style && style !== "unknown" ? ` · ${style === "bibtex" ? "BibTeX" : style === "ris" ? "RIS" : style.toUpperCase()}` : "";
  el.detected.innerHTML = n ? `<b>${n}</b> reference${n === 1 ? "" : "s"}${styleName}${n > MAX_ENTRIES ? ` · first ${MAX_ENTRIES} will be checked` : ""}` : "No references detected yet";
}, 200);

function setInput(text) {
  el.input.value = text;
  updateDetected();
}

function markSample(name) {
  $$(".samples .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.sample === name)));
}

$$("[data-sample]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const name = btn.dataset.sample;
    setInput(SAMPLES[name] || "");
    markSample(name);
    if (btn.hasAttribute("data-scroll")) document.getElementById("checker").scrollIntoView({ behavior: "smooth" });
    el.input.focus({ preventScroll: true });
    toast("Sample loaded. Press Verify to check it.");
  })
);

el.input.addEventListener("input", () => {
  markSample(null);
  updateDetected();
});

el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  }
});

el.clear.addEventListener("click", () => {
  setInput("");
  markSample(null);
  el.input.focus();
});

async function loadFile(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast("That file is larger than 2 MB.", "error");
  try {
    setInput(await file.text());
    markSample(null);
    toast(`Loaded ${file.name}`);
  } catch {
    toast(`Could not read ${file.name}`, "error");
  }
}

el.file.addEventListener("change", () => {
  loadFile(el.file.files[0]);
  el.file.value = "";
});

let dragDepth = 0;
el.drop.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  el.drop.classList.add("dragging");
});
el.drop.addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
});
el.drop.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.drop.classList.remove("dragging");
  }
});
el.drop.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0;
  el.drop.classList.remove("dragging");
  loadFile(e.dataTransfer.files[0]);
});

// ---------------------------------------------------------------------------
// Running an audit
// ---------------------------------------------------------------------------

function setBusy(busy) {
  el.verify.disabled = busy;
  el.verify.classList.toggle("busy", busy);
  el.verify.querySelector("span").textContent = busy ? "Checking…" : "Verify references";
  el.progress.classList.toggle("hidden", !busy);
}

function updateProgress() {
  const done = state.results.size;
  const pct = state.total ? Math.round((done / state.total) * 100) : 0;
  el.progressFill.style.width = `${Math.max(pct, 3)}%`;
  el.progressBar.setAttribute("aria-valuenow", String(pct));
  el.progressText.textContent = state.total ? `Checked ${done} of ${state.total}…` : "Preparing…";
}

function onStart({ total, truncated, bibliography }) {
  state.total = total;
  state.bibliography = bibliography;
  if (truncated) toast(`Checking the first ${total} references (${truncated} more skipped).`);
  renderPending();
  updateSummary();
  updateProgress();
}

function onResult(r) {
  state.results.set(r.index, r);
  const node = buildCard(r);
  const old = el.list.querySelector(`[data-index="${r.index}"]`);
  if (old) old.replaceWith(node);
  else el.list.append(node);
  applyFilters();
  updateSummary();
  updateProgress();
}

class FallbackError extends Error {}

async function runOnServer(text, signal) {
  let res;
  try {
    res = await fetch("api/verify?stream=1", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new FallbackError("Server unreachable");
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) throw new FallbackError("No API on this host");
  if (!res.ok) {
    let msg = `Server error (HTTP ${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawDone = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const evt = JSON.parse(line);
      if (evt.type === "start") onStart(evt);
      else if (evt.type === "result") onResult(evt.result);
      else if (evt.type === "done") sawDone = true;
      else if (evt.type === "error") throw new Error(evt.error);
    }
  }
  if (!sawDone && !signal.aborted) throw new Error("The server closed the connection early. Try again.");
}

async function runInBrowser(text, signal) {
  const { auditBibliography } = await import("./lib/audit.js");
  await auditBibliography(text, { signal, concurrency: 3, onStart, onResult });
}

async function run() {
  if (state.controller) return;
  const text = el.input.value.trim();
  if (!text) {
    toast("Paste some references first.", "error");
    el.input.focus();
    return;
  }
  if (!splitReferences(text).length) {
    toast("No references detected in that text.", "error");
    return;
  }
  if (state.engine === "checking") await detectEngine();

  const controller = new AbortController();
  state.controller = controller;
  state.results = new Map();
  state.cardFormat = new Map();
  state.total = 0;
  state.startedAt = Date.now();
  state.finishedAt = 0;
  el.list.innerHTML = "";
  el.results.classList.remove("hidden");
  setFilter("all");
  setBusy(true);
  updateProgress();
  requestAnimationFrame(() => el.results.scrollIntoView({ behavior: "smooth", block: "start" }));

  try {
    if (state.engine === "server") {
      try {
        await runOnServer(text, controller.signal);
      } catch (err) {
        if (!(err instanceof FallbackError)) throw err;
        setEngine("browser");
        await runInBrowser(text, controller.signal);
      }
    } else {
      await runInBrowser(text, controller.signal);
    }
    state.finishedAt = Date.now();
    const s = counts();
    toast(`Done: ${s.verified} verified, ${s.needs_review} to review, ${s.not_found} likely fabricated.`);
  } catch (err) {
    if (controller.signal.aborted) toast("Stopped.");
    else {
      console.error(err);
      toast(err.message || "Something went wrong.", "error");
    }
  } finally {
    state.finishedAt ||= Date.now();
    state.controller = null;
    setBusy(false);
    $$(".entry.pending", el.list).forEach((n) => n.remove());
    updateSummary();
    applyFilters();
  }
}

el.verify.addEventListener("click", run);
el.cancel.addEventListener("click", () => state.controller?.abort());

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPending() {
  const entries = splitReferences(el.input.value).slice(0, state.total || MAX_ENTRIES);
  el.list.innerHTML = entries
    .map(
      (raw, i) => `<article class="entry clay pending" data-index="${i + 1}" data-status="pending">
        <div class="entry-head"><span class="idx">#${String(i + 1).padStart(2, "0")}</span><span class="badge pending">${icon("sparkle")}${LABELS.pending}</span></div>
        <div class="raw well">${esc(raw)}</div><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%"></div>
      </article>`
    )
    .join("");
}

function authorLine(authors = []) {
  const names = authors.filter((a) => a.family).map((a) => [a.given, a.family].filter(Boolean).join(" "));
  if (!names.length) return "";
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} et al.` : names.join(", ");
}

function recordPanel(v) {
  const rec = v.matchedRecord || v.closestRecord;
  if (!rec) return "";
  const label = v.matchedRecord ? "Matched record" : "Closest record (does not match)";
  const url = safeUrl(rec.url);
  const doiUrl = rec.doi ? safeUrl(`https://doi.org/${rec.doi}`) : null;
  const meta = [authorLine(rec.authors), rec.year, rec.container].filter(Boolean).map(esc).join(" · ");
  const links = [];
  if (doiUrl) links.push(`<a class="link-pill" href="${esc(doiUrl)}" target="_blank" rel="noopener noreferrer">${icon("hash")}<span>${esc(rec.doi)}</span></a>`);
  if (url && url !== doiUrl) links.push(`<a class="link-pill" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon("external")}<span>Open ${esc(rec.type === "web" ? "page" : rec.source.split(" ")[0])}</span></a>`);
  if (rec.title && rec.type !== "web") links.push(`<a class="link-pill" href="https://scholar.google.com/scholar?q=${encodeURIComponent(rec.title)}" target="_blank" rel="noopener noreferrer">${icon("search")}<span>Google Scholar</span></a>`);
  return `<div class="panel">
    <div class="panel-label">${icon("db")}${esc(label)} · ${esc(rec.source)}</div>
    <h3 class="rec-title">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(rec.title || "Untitled")}</a>` : esc(rec.title || "Untitled")}</h3>
    ${meta ? `<p class="rec-meta">${meta}</p>` : ""}
    ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
  </div>`;
}

function checksPanel(v) {
  if (!v.checks?.length) return "";
  return `<div class="panel">
    <div class="panel-label">${icon("check")}Evidence</div>
    <ul class="checks">${v.checks
      .map((c) => `<li><span class="dot ${esc(c.status)}" title="${esc(c.status)}">${icon(CHECK_ICONS[c.status] || "info")}</span><b>${esc(c.label)}</b><span>${esc(c.detail)}</span></li>`)
      .join("")}</ul>
  </div>`;
}

function citationBlock(r) {
  const c = r.verification.citations;
  if (!c || r.verification.status === "not_found") return "";
  const fmt = state.cardFormat.get(r.index) || state.format;
  return `<div class="cite">
    <div class="cite-head">
      <div class="format-pick" role="radiogroup" aria-label="Citation format for reference ${r.index}">
        ${Object.entries(FORMATS)
          .map(([k, name]) => `<button type="button" role="radio" data-card-format="${k}" aria-checked="${k === fmt}">${name}</button>`)
          .join("")}
      </div>
      <button type="button" class="btn btn-soft btn-sm" data-copy>${icon("copy")}<span>Copy</span></button>
    </div>
    <pre>${esc(c[fmt] || c.apa)}</pre>
  </div>`;
}

function buildCard(r) {
  const v = r.verification;
  const st = v.status;
  const node = document.createElement("article");
  node.className = `entry clay ${st}`;
  node.dataset.index = r.index;
  node.dataset.status = st;
  const rec = v.matchedRecord || v.closestRecord || {};
  node.dataset.search = [r.raw, rec.title, rec.doi, rec.container, authorLine(rec.authors), r.parsed?.authorsRaw].filter(Boolean).join(" ").toLowerCase();

  const style = r.parsed?.style && r.parsed.style !== "unknown" ? r.parsed.style : r.parsed?.format !== "text" ? r.parsed?.format : "";
  const flags = (v.flags || []).filter(Boolean);
  const sources = v.sources || [];
  const panels = [recordPanel(v), checksPanel(v)].filter(Boolean);

  node.innerHTML = `
    <div class="entry-head">
      <span class="idx">#${String(r.index).padStart(2, "0")}</span>
      <span class="badge ${st}">${icon(ICONS[st])}${LABELS[st] || esc(st)}</span>
      ${style ? `<span class="style-tag">${esc(style)}</span>` : ""}
      <span class="meter" title="Match confidence"><span class="meter-bar"><span style="width:${Math.max(4, v.confidence || 0)}%"></span></span>${v.confidence ?? 0}%</span>
    </div>
    <div class="raw well">${esc(r.raw)}</div>
    <p class="verdict">${icon(ICONS[st])}<span>${esc(v.message)}</span></p>
    ${panels.length ? `<div class="grid2">${panels.join("")}</div>` : ""}
    ${flags.length ? `<ul class="flags">${flags.map((f) => `<li class="${esc(f.level)}">${icon(FLAG_ICONS[f.level] || "info")}<span>${esc(f.text)}</span></li>`).join("")}</ul>` : ""}
    ${citationBlock(r)}
    ${
      sources.length
        ? `<details class="sources"><summary>${icon("chevron")}Sources queried (${sources.length})</summary><ul>${sources
            .map((s) => `<li class="${esc(s.status)}" title="${esc(s.detail || "")}">${esc(s.name)}: ${s.status === "hit" ? "found" : s.status === "miss" ? "no match" : "unavailable"}</li>`)
            .join("")}</ul></details>`
        : ""
    }`;
  return node;
}

function counts() {
  const c = { verified: 0, needs_review: 0, not_found: 0 };
  for (const r of state.results.values()) c[r.verification.status] = (c[r.verification.status] || 0) + 1;
  return c;
}

const RING = 2 * Math.PI * 50;
function updateSummary() {
  const c = counts();
  const done = state.results.size;
  const total = state.total || done;
  $("#nAll").textContent = done;
  $("#nOk").textContent = c.verified;
  $("#nWarn").textContent = c.needs_review;
  $("#nBad").textContent = c.not_found;

  let offset = 0;
  for (const [id, n] of [["ringOk", c.verified], ["ringWarn", c.needs_review], ["ringBad", c.not_found]]) {
    const len = total ? (n / total) * RING : 0;
    const seg = $(`#${id}`);
    seg.style.strokeDasharray = `${Math.max(0, len - (len > 6 ? 4 : 0))} ${RING}`;
    seg.style.strokeDashoffset = String(-offset);
    offset += len;
  }
  const pct = done ? Math.round((c.verified / done) * 100) : 0;
  $("#scoreNum").textContent = `${pct}%`;
  $("#scoreRing").setAttribute("aria-label", `${pct}% of checked references verified`);

  const style = state.bibliography?.style;
  const styleName = style && style !== "unknown" ? (style === "bibtex" ? "BibTeX" : style === "ris" ? "RIS" : style.toUpperCase()) : "Mixed";
  const secs = ((state.finishedAt || Date.now()) - state.startedAt) / 1000;
  const parts = [`${done} of ${total} checked`, `${styleName} style`, state.engine === "server" ? "server engine" : "browser engine"];
  if (state.finishedAt) parts.push(`${secs.toFixed(1)}\u00a0s`);
  $("#summaryMeta").textContent = parts.join(" · ");
}

function applyFilters() {
  const q = state.query;
  let shown = 0;
  for (const card of $$(".entry", el.list)) {
    const okStatus = state.filter === "all" || card.dataset.status === state.filter || card.dataset.status === "pending";
    const okQuery = !q || (card.dataset.search || card.textContent.toLowerCase()).includes(q);
    const visible = okStatus && okQuery && !(state.filter !== "all" && card.dataset.status === "pending");
    card.classList.toggle("hidden", !visible);
    if (visible) shown++;
  }
  let empty = $(".empty", el.list);
  if (!shown && state.results.size) {
    if (!empty) {
      empty = Object.assign(document.createElement("p"), { className: "empty clay" });
      el.list.append(empty);
    }
    empty.textContent = q ? `No references match “${state.query}”.` : "No references in this group.";
  } else empty?.remove();
}

function setFilter(f) {
  state.filter = f;
  $$(".stat").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === f)));
  applyFilters();
}

$$(".stat").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
el.search.addEventListener(
  "input",
  debounce(() => {
    state.query = el.search.value.trim().toLowerCase();
    applyFilters();
  }, 120)
);

function setGlobalFormat(fmt) {
  state.format = fmt;
  store.set("format", fmt);
  state.cardFormat.clear();
  $$(".toolbar [data-format]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.format === fmt)));
  for (const r of state.results.values()) refreshCitation(r.index);
}
$$(".toolbar [data-format]").forEach((b) => b.addEventListener("click", () => setGlobalFormat(b.dataset.format)));
$$(".toolbar [data-format]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.format === state.format)));

function refreshCitation(index) {
  const r = state.results.get(index);
  const card = el.list.querySelector(`.entry[data-index="${index}"]`);
  const block = card?.querySelector(".cite");
  if (!r || !block) return;
  const fmt = state.cardFormat.get(index) || state.format;
  block.querySelector("pre").textContent = r.verification.citations[fmt] || r.verification.citations.apa;
  $$("[data-card-format]", block).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.cardFormat === fmt)));
}

el.list.addEventListener("click", async (e) => {
  const card = e.target.closest(".entry");
  if (!card) return;
  const index = Number(card.dataset.index);
  const fmtBtn = e.target.closest("[data-card-format]");
  if (fmtBtn) {
    state.cardFormat.set(index, fmtBtn.dataset.cardFormat);
    refreshCitation(index);
    return;
  }
  const copyBtn = e.target.closest("[data-copy]");
  if (copyBtn) {
    const text = card.querySelector(".cite pre")?.textContent || "";
    if (await copyText(text)) {
      const label = copyBtn.querySelector("span");
      label.textContent = "Copied!";
      setTimeout(() => (label.textContent = "Copy"), 1500);
      toast(`Copied ${FORMATS[state.cardFormat.get(index) || state.format]} citation`);
    } else toast("Copy failed. Select the text manually.", "error");
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const ordered = () => [...state.results.values()].sort((a, b) => a.index - b.index);
const usable = () => ordered().filter((r) => r.verification.citations && r.verification.status !== "not_found");

$("#copyAllBtn").addEventListener("click", async () => {
  const list = usable();
  if (!list.length) return toast("Nothing to copy yet.", "error");
  const fmt = state.format;
  const text = list.map((r) => r.verification.citations[fmt]).join(fmt === "bibtex" ? "\n\n" : "\n\n");
  if (await copyText(text)) toast(`Copied ${list.length} ${FORMATS[fmt]} citation${list.length === 1 ? "" : "s"}`);
  else toast("Copy failed.", "error");
});

const exporters = {
  bib() {
    const lines = [`% VeriBib export, ${new Date().toISOString()}`, "% Citations rebuilt from registry records. Review entries marked NEEDS REVIEW.", ""];
    for (const r of ordered()) {
      const v = r.verification;
      if (v.citations && v.status !== "not_found") {
        if (v.status === "needs_review") lines.push(`% NEEDS REVIEW (#${r.index}): ${v.message}`);
        lines.push(v.citations.bibtex, "");
      } else lines.push(`% LIKELY FABRICATED (#${r.index}) — not exported: ${r.raw.replace(/\s+/g, " ").slice(0, 200)}`, "");
    }
    download(lines.join("\n"), `veribib-${stamp()}.bib`, "application/x-bibtex");
  },
  md() {
    const c = counts();
    let md = `# VeriBib citation report\n\n_${new Date().toLocaleString()} · ${state.results.size} references · ${c.verified} verified · ${c.needs_review} need review · ${c.not_found} likely fabricated_\n\n`;
    for (const r of ordered()) {
      const v = r.verification;
      md += `## ${r.index}. ${LABELS[v.status]} (${v.confidence}%)\n\n> ${r.raw.replace(/\s+/g, " ")}\n\n**${v.message}**\n\n`;
      for (const ch of v.checks || []) md += `- ${ch.status.toUpperCase()} · ${ch.label}: ${ch.detail}\n`;
      for (const f of v.flags || []) md += `- ⚠ ${f.text}\n`;
      const rec = v.matchedRecord;
      if (rec) md += `\nMatched in ${rec.source}: ${rec.title}${rec.doi ? ` — https://doi.org/${rec.doi}` : rec.url ? ` — ${rec.url}` : ""}\n`;
      if (v.citations && v.status !== "not_found") md += `\n\`\`\`\n${v.citations[state.format]}\n\`\`\`\n`;
      md += "\n";
    }
    download(md, `veribib-report-${stamp()}.md`, "text/markdown");
  },
  csv() {
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""').replace(/\s+/g, " ")}"`;
    const rows = [["#", "status", "confidence", "reference", "verdict", "matched_title", "source", "doi", "url", "corrected_" + state.format]];
    for (const r of ordered()) {
      const v = r.verification;
      const m = v.matchedRecord || {};
      rows.push([r.index, v.status, v.confidence, r.raw, v.message, m.title, m.source, m.doi, m.url, v.status !== "not_found" ? v.citations?.[state.format] : ""]);
    }
    download("﻿" + rows.map((row) => row.map(q).join(",")).join("\r\n"), `veribib-${stamp()}.csv`, "text/csv");
  },
  json() {
    const c = counts();
    const data = { generatedAt: new Date().toISOString(), engine: state.engine, bibliography: state.bibliography, summary: { total: state.results.size, verified: c.verified, needsReview: c.needs_review, notFound: c.not_found }, results: ordered() };
    download(JSON.stringify(data, null, 2), `veribib-${stamp()}.json`, "application/json");
  },
};

const menu = $(".menu");
$$("[data-export]").forEach((b) =>
  b.addEventListener("click", () => {
    menu.open = false;
    if (!state.results.size) return toast("Run a check first.", "error");
    exporters[b.dataset.export]();
  })
);
document.addEventListener("click", (e) => {
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menu.open) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || "");
$(".shortcut").textContent = isMac ? "⌘ ↵" : "Ctrl ↵";

const draft = store.get("draft");
if (draft) setInput(draft);
detectEngine();
