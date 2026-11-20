// Verification engine: look an entry up by its identifiers, search registries,
// score each candidate record, and reach a verdict with human-readable evidence.

import * as P from "./providers.js";
import { titleSimilarity, tokenCover, surnameKey, jaroWinkler } from "./fuzzy.js";
import { formatAll } from "./format.js";

const WEIGHTS = { title: 55, authors: 25, year: 15, venue: 5 };
const SOURCE_RANK = { Crossref: 7, PubMed: 6, arXiv: 5, "arXiv (DataCite)": 5, OpenAlex: 4, DataCite: 3, "Google Books": 2 };
const CS_HINT = /\b(?:neural|learning|transformer|language model|llm|attention|network|vision|reinforcement|quantum|algorithm|dataset|benchmark|diffusion|graph|agent|robot|optimization|inference|embedding|gpt|bert)\b/i;
const BIO_HINT = /\b(?:patients?|clinical|cancer|tumou?r|disease|cells?|protein|gene|genom|mice|mouse|rats?|therapy|trial|infection|virus|covid|sars|health|medicine|medical|blood|brain|neuro|cardio|diabetes|drug|pharma|vaccine|epidemiolog)\w*/i;

const pct = (x) => Math.round(x * 100);
const short = (s, n = 90) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");

function recSurnames(rec) {
  return [...new Set((rec.authors || []).map((a) => surnameKey(a.family)).filter(Boolean))];
}

function sameSurname(a, b) {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5 && jaroWinkler(a, b) >= 0.93) return true;
  return false;
}

function sameId(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// ---------------------------------------------------------------------------
// Scoring one candidate
// ---------------------------------------------------------------------------

export function scoreCandidate(entry, rec, via = "search") {
  const parts = {};
  const flags = [];
  const isWeb = rec.type === "web";

  // Title
  let titleSim = null;
  if (entry.title) titleSim = titleSimilarity(entry.title, rec.title);
  else if (!entry.doi && !entry.arxivId && !entry.url && entry.raw?.length >= 20) titleSim = 0.9 * tokenCover(entry.raw, rec.title, true);
  if (titleSim != null) parts.title = titleSim;

  // Authors
  const E = entry.surnames || [];
  const R = recSurnames(rec);
  let authorInfo = null;
  if (E.length && R.length) {
    const overlap = E.filter((s) => R.some((r) => sameSurname(s, r))).length;
    const firstOk = R.some((r) => sameSurname(E[0], r));
    parts.authors = 0.6 * (overlap / E.length) + 0.4 * (firstOk ? 1 : 0);
    authorInfo = { overlap, of: E.length, firstOk, recordFirst: rec.authors[0] };
    if (!overlap) flags.push({ level: "high", code: "authors", text: `None of the cited authors (${E.slice(0, 3).join(", ")}) appear on the record, which lists ${rec.authors.slice(0, 3).map((a) => a.family).join(", ")}${rec.authors.length > 3 ? " et al." : ""}.` });
    else if (!firstOk) flags.push({ level: "medium", code: "authors", text: `First author “${E[0]}” is not on the record.` });
    else if (overlap / E.length < 0.5 && E.length >= 3) flags.push({ level: "medium", code: "authors", text: `Only ${overlap} of ${E.length} cited authors appear on the record.` });
  } else if (E.length && isWeb && rec.web?.textHasAuthor != null) {
    parts.authors = rec.web.textHasAuthor ? 1 : 0.3;
    authorInfo = { onPage: rec.web.textHasAuthor };
    if (!rec.web.textHasAuthor) flags.push({ level: "medium", code: "authors", text: `Cited author “${E[0]}” is not named on the page.` });
  }

  // Year. A work can legitimately carry several years (online-first vs. the printed issue),
  // so the cited year is compared against every year on the record and the closest wins.
  let yearInfo = null;
  if (entry.year && rec.year) {
    const recYears = rec.years?.length ? rec.years : [rec.year];
    const cited = [entry.year, ...(entry.altYears || [])];
    let pair = { c: entry.year, r: rec.year, diff: Infinity };
    for (const c of cited) for (const r of recYears) if (Math.abs(c - r) < pair.diff) pair = { c, r, diff: Math.abs(c - r) };
    const { diff } = pair;
    parts.year = diff === 0 ? 1 : diff === 1 ? 0.85 : diff <= 3 ? 0.4 : 0;
    yearInfo = { cited: pair.c, record: pair.r, diff, years: recYears };
    if (diff >= 2) flags.push({ level: diff >= 4 ? "high" : "medium", code: "year", text: `Cited year ${entry.year}, but the record is from ${recYears.length > 1 ? recYears.join(" / ") : rec.year}.` });
  }

  // Venue (positive evidence only — abbreviations make mismatches unreliable)
  if (entry.venue && rec.container && !isWeb) {
    const cov = Math.max(tokenCover(rec.container, entry.venue, true), tokenCover(entry.venue, rec.container, true));
    if (cov >= 0.5) parts.venue = cov;
  }

  let num = 0;
  let den = 0;
  for (const [k, v] of Object.entries(parts)) {
    num += WEIGHTS[k] * v;
    den += WEIGHTS[k];
  }
  let score = den ? (100 * num) / den : 0;

  // Identifier evidence
  const idMatch =
    (via === "doi" && sameId(entry.doi, rec.doi)) ||
    (via === "arxiv" && sameId(entry.arxivId, rec.arxivId)) ||
    via === "pmid" ||
    via === "isbn" ||
    via === "url";
  if (idMatch) {
    if (titleSim == null) score = den ? 60 + 0.4 * score : 92;
    else if (titleSim >= 0.6) score = Math.max(score, 50 + score / 2);
    else if (via !== "url") flags.push({ level: "high", code: "id-mismatch", text: `The ${via === "doi" ? "DOI" : via === "arxiv" ? "arXiv ID" : "identifier"} belongs to a different work: “${short(rec.title)}”.` });
  }
  if (titleSim != null && titleSim < 0.5 && !idMatch) flags.push({ level: "high", code: "title", text: `Closest title found is “${short(rec.title)}”.` });
  else if (titleSim != null && titleSim < 0.8 && titleSim >= 0.5) flags.push({ level: "medium", code: "title", text: `Title only partly matches the record (${pct(titleSim)}%).` });

  return { rec, via, idMatch, score: Math.max(0, Math.min(100, Math.round(score))), titleSim, authorInfo, yearInfo, flags, parts };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function makeLog() {
  const sources = [];
  return {
    sources,
    async run(name, fn) {
      try {
        const out = await fn();
        const n = Array.isArray(out) ? out.length : out ? 1 : 0;
        sources.push({ name, status: n ? "hit" : "miss", count: n });
        return out;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        sources.push({ name, status: "error", detail: err.message });
        return undefined;
      }
    },
  };
}

async function resolveDoi(doi, log, opts) {
  const cr = await log.run("Crossref DOI", () => P.crossrefByDoi(doi, opts));
  if (cr) return { state: "found", rec: cr };
  const dc = await log.run("DataCite DOI", () => P.dataciteByDoi(doi, opts));
  if (dc) return { state: "found", rec: dc };
  const oa = P.isRateLimited("api.openalex.org") ? undefined : await log.run("OpenAlex DOI", () => P.openalexByDoi(doi, opts));
  if (oa) return { state: "found", rec: oa };
  const reg = await log.run("doi.org handle", () => P.doiIsRegistered(doi, opts).then((x) => (x ? [true] : [])));
  if (reg === undefined) return { state: "unknown" };
  return { state: reg.length ? "registered" : "missing" };
}

function dedupe(cands) {
  const seen = new Map();
  for (const c of cands) {
    const key = c.rec.doi || `${(c.rec.title || "").toLowerCase().slice(0, 80)}|${c.rec.year}|${c.rec.source}`;
    const prev = seen.get(key);
    if (!prev || c.score > prev.score || (c.idMatch && !prev.idMatch)) seen.set(key, c);
  }
  return [...seen.values()];
}

function pickBest(scored) {
  return [...scored].sort((a, b) => b.score - a.score || Number(b.idMatch) - Number(a.idMatch) || (SOURCE_RANK[b.rec.source] || 0) - (SOURCE_RANK[a.rec.source] || 0))[0] || null;
}

const hasHigh = (c) => c?.flags.some((f) => f.level === "high");
const isStrong = (c) => c && c.score >= 80 && !hasHigh(c) && (c.titleSim == null || c.titleSim >= 0.8);

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function verifyEntry(entry, { signal } = {}) {
  const started = Date.now();
  const opts = { signal };
  const log = makeLog();
  const scored = [];
  const entryFlags = [];
  const add = (rec, via) => rec && scored.push(scoreCandidate(entry, rec, via));

  const thisYear = new Date().getFullYear();
  if (entry.year && entry.year > thisYear) entryFlags.push({ level: "high", code: "future", text: `Publication year ${entry.year} is in the future.` });

  // 1. Identifier lookups (in parallel)
  let doi = null;
  let page = null;
  const urlIsRegistry = entry.url && /(?:doi\.org|arxiv\.org)\//i.test(entry.url);
  await Promise.all([
    entry.doi && resolveDoi(entry.doi, log, opts).then((r) => ((doi = r), add(r.rec, "doi"))),
    entry.arxivId && log.run(P.IS_NODE ? "arXiv ID" : "arXiv ID (DataCite)", () => P.arxivById(entry.arxivId, opts)).then((r) => add(r, "arxiv")),
    entry.pmid && log.run("PubMed ID", () => P.pubmedById(entry.pmid, opts)).then((r) => add(r, "pmid")),
    entry.isbn && log.run("Google Books ISBN", () => P.googleBooksSearch({ isbn: entry.isbn }, opts)).then((r) => add(r?.[0], "isbn")),
    entry.url && !urlIsRegistry && !entry.doi && P.inspectWebPage(entry.url, opts).then((p) => ((page = p), log.sources.push({ name: `Link (${p.host || "web"})`, status: p.ok ? "hit" : p.ok === null ? "error" : "miss", detail: p.reason }), add(P.webRecord(p, entry), "url"))),
  ]);

  if (doi?.state === "missing") entryFlags.push({ level: "high", code: "doi-missing", text: `DOI ${entry.doi} is not registered with any DOI agency.` });
  if (page && page.ok === false) entryFlags.push({ level: page.dead ? "high" : "medium", code: "link", text: `Link ${page.dead ? "is dead" : "failed"}: ${page.reason}.` });

  // 2. Registry search when identifiers did not settle it
  const queryTitle = entry.title || (!entry.doi && !entry.arxivId && entry.raw?.length >= 20 ? entry.raw.replace(/https?:\/\/\S+/g, "").slice(0, 200) : null);
  const q = { title: queryTitle, author: entry.surnames?.[0] || "", year: entry.year };
  let best = pickBest(scored);

  if (queryTitle && queryTitle.length >= 6 && !isStrong(best)) {
    const csLike = CS_HINT.test(queryTitle) || /arxiv|neurips|nips|icml|iclr|cvpr|acl|emnlp|aaai/i.test(entry.raw || "");
    const preprintish = csLike || ["preprint", "misc", "report", "thesis", "dataset"].includes(entry.type) || !entry.venue;
    const stageA = [
      log.run("Crossref search", () => P.crossrefSearch(q, opts)).then((r) => r?.forEach((x) => add(x, "search"))),
      !P.isRateLimited("api.openalex.org") && log.run("OpenAlex search", () => P.openalexSearch(q, opts)).then((r) => r?.forEach((x) => add(x, "search"))),
      preprintish && log.run("DataCite search", () => P.dataciteSearch(q, { ...opts, rows: 4 })).then((r) => r?.forEach((x) => add(x, "search"))),
    ];
    await Promise.all(stageA);
    best = pickBest(scored);

    if (!isStrong(best)) {
      const stageB = [
        P.IS_NODE && csLike && !isRateLimited("export.arxiv.org") && log.run("arXiv search", () => P.arxivSearch(q, { ...opts, rows: 3 })).then((r) => r?.forEach((x) => add(x, "search"))),
        (BIO_HINT.test(queryTitle) || BIO_HINT.test(entry.venue || "") || !csLike) && log.run("PubMed search", () => P.pubmedSearch(q, opts)).then((r) => r?.forEach((x) => add(x, "search"))),
        (entry.type === "book" || (best?.score ?? 0) < 55) && log.run("Google Books", () => P.googleBooksSearch(q, opts)).then((r) => r?.forEach((x) => add(x, "search"))),
      ];
      await Promise.all(stageB);
    }
  }

  const candidates = dedupe(scored);
  best = pickBest(candidates);
  const idCand = candidates.filter((c) => c.idMatch).sort((a, b) => b.score - a.score)[0] || null;
  return decide({ entry, best, idCand, doi, page, entryFlags, sources: log.sources, started });
}

function isRateLimited(host) {
  return P.isRateLimited(host);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function decide({ entry, best, idCand, doi, page, entryFlags, sources, started }) {
  let status = "not_found";
  let message = "";
  let chosen = best;
  const flags = [...entryFlags];
  const allErrored = sources.length > 0 && sources.every((s) => s.status === "error");

  // A real DOI attached to a different paper is a classic fabrication pattern.
  const idMismatch = idCand && hasHigh(idCand) && idCand.flags.some((f) => f.code === "id-mismatch");
  if (idMismatch) flags.push(idCand.flags.find((f) => f.code === "id-mismatch"));

  const titleOk = (c) => c && (c.titleSim == null || c.titleSim >= 0.8 || (c.idMatch && c.titleSim >= 0.6));
  const ownHigh = (c) => c?.flags.filter((f) => f.level === "high" && f.code !== "id-mismatch") || [];
  const ownMedium = (c) => c?.flags.filter((f) => f.level === "medium") || [];
  const blocking = flags.filter((f) => f.level === "high");

  if (best && best.score >= 78 && titleOk(best) && !ownHigh(best).length && !ownMedium(best).length && !blocking.length) {
    status = "verified";
    message = best.rec.type === "web" ? `Live page found on ${best.rec.siteName}; title${best.authorInfo?.onPage ? " and author" : ""} match.` : `Matches a ${best.rec.type === "preprint" ? "preprint" : "published record"} in ${best.rec.source}.`;
    if (best.idMatch && best.titleSim == null) message = `${best.via === "doi" ? "DOI" : best.via === "arxiv" ? "arXiv ID" : "Identifier"} resolves to a real record in ${best.rec.source}.`;
  } else if (best && best.score >= 55 && (best.titleSim == null || best.titleSim >= 0.55 || best.idMatch) && !ownHigh(best).length) {
    status = "needs_review";
    const issues = [...blocking, ...ownMedium(best)];
    if (doi?.state === "missing") message = `The work exists in ${best.rec.source}, but the cited DOI does not.`;
    else if (idMismatch) message = `The work exists in ${best.rec.source}, but the cited identifier points to a different paper.`;
    else if (page && page.ok === false) message = `The work exists in ${best.rec.source}, but the cited link is broken.`;
    else message = `Close match in ${best.rec.source}, with ${issues.length ? "discrepancies to check" : "a partial match"}.`;
  } else if (page && page.ok !== false && doi?.state !== "missing" && !idMismatch) {
    // A live (or uninspectable) link with no solid registry match: a human should look.
    status = "needs_review";
    chosen = null;
    const webCand = best?.rec.type === "web" ? best : null;
    if (page.ok === null) message = `The link could not be inspected (${page.reason}). Check it manually.`;
    else if (!page.inspected) message = P.IS_NODE ? `The link works (${page.reason}), but its content could not be compared with the citation.` : "The link’s host responded, but browsers can’t read other sites, so the page wasn’t compared. Self-host VeriBib for full link checks.";
    else message = `The link works, but the page title doesn’t match the citation${webCand?.rec.title ? ` (the page says “${short(webCand.rec.title, 70)}”)` : ""}.`;
  } else if (!best && doi?.state === "registered") {
    status = "needs_review";
    message = "DOI is registered, but no registry exposes its metadata. Check it manually.";
  } else if ((!best || best.score < 55) && (allErrored || doi?.state === "unknown" || primarySearchFailed(sources)) && doi?.state !== "missing" && !idMismatch && !(page?.ok === false && page.dead)) {
    status = "needs_review";
    message = "The main registries were busy or unreachable, so this entry could not be fully checked. Try again in a minute.";
  } else {
    status = "not_found";
    chosen = null;
    const reasons = [];
    if (doi?.state === "missing") reasons.push(`DOI ${entry.doi} does not exist`);
    if (idMismatch) reasons.push("its identifier belongs to a different paper");
    if (page?.ok === false) reasons.push(page.dead ? "the link is dead" : "the link failed to load");
    if (flags.some((f) => f.code === "future")) reasons.push("the year is in the future");
    if (best && best.titleSim >= 0.8 && ownHigh(best).some((f) => f.code === "authors")) reasons.push("a work with this title exists, but by different authors");
    else if (entry.title || queryable(entry)) reasons.push("no registry has a matching record");
    if (!entry.title && !entry.doi && !entry.arxivId && !entry.url) message = "Could not find a title or identifier in this entry.";
    else message = `Likely fabricated: ${reasons.join("; ")}.`;
    message = message.charAt(0).toUpperCase() + message.slice(1);
  }

  const shown = chosen || null;
  const confidence = status === "not_found" ? Math.min(best?.score ?? 0, 49) : best ? best.score : 50;
  // Evidence from an unrelated "closest" record is noise, so only keep it when it is plausibly the same work.
  const related = best && (best.titleSim == null || best.titleSim >= 0.55);
  const evidence = shown || (related ? best : null);
  const checks = buildChecks(entry, evidence, { doi, page, idCand });
  if (!evidence && best?.titleSim != null) checks.push({ id: "title", label: "Title", status: "fail", detail: `No registry title matches (closest is ${pct(best.titleSim)}% similar)` });
  const candFlags = shown ? shown.flags.filter((f) => f.code !== "id-mismatch" || !idMismatch) : related ? best.flags : [];
  const allFlags = dedupeFlags([...flags, ...candFlags]);

  return {
    status,
    confidence,
    message,
    matchedRecord: shown ? shown.rec : null,
    closestRecord: !shown && related && best.score >= 30 && best.rec.type !== "web" ? best.rec : null,
    titleSimilarity: best?.titleSim != null ? pct(best.titleSim) : null,
    checks,
    flags: allFlags,
    sources,
    citations: shown && shown.rec.title ? formatAll(shown.rec) : null,
    durationMs: Date.now() - started,
  };
}

// Crossref (or OpenAlex) is the backbone of title search; if neither answered, absence proves nothing.
function primarySearchFailed(sources) {
  const cr = sources.find((s) => s.name === "Crossref search");
  const oa = sources.find((s) => s.name === "OpenAlex search");
  return !!cr && cr.status === "error" && (!oa || oa.status === "error");
}

function queryable(entry) {
  return !entry.doi && !entry.arxivId && (entry.raw || "").length >= 20;
}

function dedupeFlags(list) {
  const seen = new Set();
  return list.filter((f) => f && !seen.has(f.text) && seen.add(f.text));
}

function buildChecks(entry, c, { doi, page, idCand }) {
  const checks = [];
  const mismatched = (via) => idCand?.via === via && idCand.flags.some((f) => f.code === "id-mismatch");
  if (entry.doi) {
    const map = {
      found: mismatched("doi") ? ["fail", "Resolves, but to a different work"] : ["pass", `Resolves (${doi?.rec?.source || "registered"})`],
      missing: ["fail", "Not registered with any DOI agency"],
      registered: ["warn", "Registered, but no metadata available"],
      unknown: ["info", "Could not be checked right now"],
    };
    const [s, d] = map[doi?.state || "unknown"];
    checks.push({ id: "doi", label: "DOI", status: s, detail: `${entry.doi} — ${d}` });
  }
  if (entry.arxivId) {
    const found = idCand?.via === "arxiv" || c?.via === "arxiv";
    const bad = mismatched("arxiv");
    checks.push({ id: "arxiv", label: "arXiv ID", status: found ? (bad ? "fail" : "pass") : "fail", detail: `${entry.arxivId} — ${found ? (bad ? "belongs to a different paper" : "resolves") : "not found"}` });
  }
  if (page) checks.push({ id: "link", label: "Link", status: page.ok ? "pass" : page.ok === null ? "warn" : "fail", detail: page.reason });
  if (!c) return checks;
  if (c.titleSim != null) checks.push({ id: "title", label: "Title", status: c.titleSim >= 0.8 ? "pass" : c.titleSim >= 0.55 ? "warn" : "fail", detail: `${pct(c.titleSim)}% similar to “${short(c.rec.title, 110)}”` });
  if (c.authorInfo) {
    const a = c.authorInfo;
    if ("onPage" in a) checks.push({ id: "authors", label: "Authors", status: a.onPage ? "pass" : "warn", detail: a.onPage ? "Cited author is named on the page" : "Cited author not found on the page" });
    else checks.push({ id: "authors", label: "Authors", status: !a.overlap ? "fail" : a.firstOk && a.overlap / a.of >= 0.5 ? "pass" : "warn", detail: `${a.overlap} of ${a.of} cited author${a.of === 1 ? "" : "s"} on record${a.firstOk ? "" : "; first author missing"}` });
  } else if (entry.surnames?.length && !(c.rec.authors || []).length) {
    checks.push({ id: "authors", label: "Authors", status: "info", detail: "Record has no author data to compare" });
  }
  if (c.yearInfo) {
    const y = c.yearInfo;
    checks.push({ id: "year", label: "Year", status: y.diff === 0 ? "pass" : y.diff === 1 ? "info" : "warn", detail: y.diff === 0 ? (y.years.length > 1 ? `${y.cited} matches (record dates: ${y.years.join(" / ")})` : `${y.cited} matches`) : `Cited ${y.cited}, record ${y.years.length > 1 ? y.years.join(" / ") : y.record}${y.diff === 1 ? " (online vs. issue or preprint vs. published dates often differ)" : ""}` });
  }
  if (c.parts.venue != null) checks.push({ id: "venue", label: "Venue", status: "pass", detail: short(c.rec.container, 100) });
  return checks;
}
