// Audit a whole bibliography: split, parse, verify concurrently, summarize.
// Shared by the Node server (/api/verify) and the in-browser engine.

import { splitReferences, extractFields, detectBibliography, detectEntryStyle } from "./parse.js";
import { verifyEntry } from "./verify.js";
import { normalize } from "./fuzzy.js";
import { RUNTIME, configure } from "./providers.js";

export { configure, RUNTIME };
export const MAX_ENTRIES = 150;

export function prepare(text, { maxEntries = MAX_ENTRIES } = {}) {
  const all = splitReferences(text);
  const entries = all.slice(0, maxEntries);
  return {
    entries,
    truncated: all.length - entries.length,
    bibliography: { ...detectBibliography(entries), count: entries.length },
  };
}

function duplicateKey(p) {
  if (p.doi) return `doi:${p.doi.toLowerCase()}`;
  if (p.arxivId) return `arxiv:${p.arxivId.toLowerCase()}`;
  if (p.title && p.title.length > 12) return `t:${normalize(p.title)}`;
  return null;
}

export function summarize(results, startedAt) {
  const count = (s) => results.filter((r) => r.verification.status === s).length;
  const total = results.length;
  return {
    total,
    verified: count("verified"),
    needsReview: count("needs_review"),
    notFound: count("not_found"),
    averageConfidence: total ? Math.round(results.reduce((a, r) => a + (r.verification.confidence || 0), 0) / total) : 0,
    durationMs: Date.now() - startedAt,
    engine: RUNTIME,
  };
}

async function mapPool(items, limit, fn, signal) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * @param {string} text raw bibliography
 * @param {{concurrency?: number, signal?: AbortSignal, onStart?: Function, onResult?: Function, maxEntries?: number}} options
 */
export async function auditBibliography(text, { concurrency = 4, signal, onStart, onResult, maxEntries } = {}) {
  const startedAt = Date.now();
  const { entries, truncated, bibliography } = prepare(text, { maxEntries });
  onStart?.({ total: entries.length, truncated, bibliography });

  const seen = new Map();
  const parsed = entries.map((raw, i) => {
    const p = extractFields(raw);
    p.style = detectEntryStyle(raw).style;
    const key = duplicateKey(p);
    if (key) {
      if (seen.has(key)) p.duplicateOf = seen.get(key);
      else seen.set(key, i + 1);
    }
    return p;
  });

  const results = new Array(entries.length);
  await mapPool(
    parsed,
    concurrency,
    async (p, i) => {
      let verification;
      try {
        verification = await verifyEntry(p, { signal });
      } catch (err) {
        if (signal?.aborted) return;
        verification = { status: "needs_review", confidence: 0, message: `Check failed: ${err.message}`, checks: [], flags: [], sources: [], matchedRecord: null, citations: null };
      }
      if (p.duplicateOf) verification.flags = [{ level: "medium", code: "duplicate", text: `Duplicate of reference #${p.duplicateOf}.` }, ...(verification.flags || [])];
      const { raw, ...fields } = p;
      const result = { index: i + 1, raw: entries[i], parsed: fields, verification };
      results[i] = result;
      onResult?.(result);
    },
    signal
  );

  const done = results.filter(Boolean);
  return { bibliography, truncated, summary: summarize(done, startedAt), results: done };
}
