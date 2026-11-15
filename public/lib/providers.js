// Keyless scholarly registry clients: Crossref, OpenAlex, DataCite, doi.org,
// arXiv, PubMed and Google Books, plus a live web-page inspector.
//
// Runs in Node (server mode) and in the browser (static hosting). Every lookup
// resolves to a normalized record, `null` (definitively not found), or throws a
// ProviderError (network failure, rate limit) so callers can tell
// "does not exist" apart from "could not check".

import { cleanText } from "./fuzzy.js";

export const IS_NODE = typeof window === "undefined" && typeof process !== "undefined" && !!process.versions?.node;
export const RUNTIME = IS_NODE ? "server" : "browser";

const config = {
  mailto: null, // contact e-mail for Crossref/OpenAlex/NCBI "polite" pools (server only)
  openalexKey: null,
  timeoutMs: 15000,
  userAgent: "VeriBib/2.0 (+https://github.com/TakMashhido/VeriBib)",
};

export function configure(options = {}) {
  for (const [k, v] of Object.entries(options)) if (v !== undefined && k in config) config[k] = v || null;
  if (!config.timeoutMs) config.timeoutMs = 15000;
  if (!config.userAgent) config.userAgent = "VeriBib/2.0";
}

export class ProviderError extends Error {
  constructor(message, { status = 0, host = "" } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.host = host;
  }
}

// ---------------------------------------------------------------------------
// Per-host scheduling (rate limits), caching, retries
// ---------------------------------------------------------------------------

const HOST_LIMITS = {
  "api.crossref.org": { concurrency: 1, interval: 1050 }, // public pool; adapts to x-rate-limit headers
  "api.openalex.org": { concurrency: 3, interval: 110 },
  "api.datacite.org": { concurrency: 3, interval: 110 },
  "doi.org": { concurrency: 3, interval: 60 },
  "export.arxiv.org": { concurrency: 1, interval: 3000 }, // arXiv asks for one request every 3 s
  "eutils.ncbi.nlm.nih.gov": { concurrency: 1, interval: 350 }, // NCBI: 3 req/s without a key
  "www.googleapis.com": { concurrency: 2, interval: 250 },
};

const lanes = new Map();

function laneFor(host) {
  let l = lanes.get(host);
  if (!l) {
    l = { active: 0, last: 0, queue: [], timer: null, disabledUntil: 0, cfg: HOST_LIMITS[host] || { concurrency: 4, interval: 0 } };
    lanes.set(host, l);
  }
  return l;
}

function pump(l) {
  while (l.active < l.cfg.concurrency && l.queue.length) {
    const wait = l.last + l.cfg.interval - Date.now();
    if (wait > 0) {
      if (!l.timer) l.timer = setTimeout(() => ((l.timer = null), pump(l)), wait);
      return;
    }
    l.active++;
    l.last = Date.now();
    l.queue.shift()();
  }
}

async function scheduled(host, fn) {
  const l = laneFor(host);
  await new Promise((resolve) => {
    l.queue.push(resolve);
    pump(l);
  });
  try {
    return await fn();
  } finally {
    l.active--;
    pump(l);
  }
}

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 3000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.t > CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  return hit.p;
}

function cacheSet(key, p) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), p });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function timeoutSignal(ms, outer) {
  const t = AbortSignal.timeout(ms);
  if (!outer) return t;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([t, outer]) : outer;
}

function headersFor(as) {
  const h = { Accept: as === "json" ? "application/json" : as === "xml" ? "application/atom+xml, application/xml" : "*/*" };
  if (IS_NODE) h["User-Agent"] = config.mailto ? `${config.userAgent} (mailto:${config.mailto})` : config.userAgent;
  return h;
}

// Registries such as Crossref announce their limits in response headers; follow them.
function adaptLane(lane, headers) {
  const limit = parseInt(headers.get("x-rate-limit-limit"), 10);
  const interval = parseFloat(headers.get("x-rate-limit-interval")) || 1;
  const conc = parseInt(headers.get("x-concurrency-limit"), 10);
  if (limit > 0) lane.cfg = { ...lane.cfg, interval: Math.ceil((interval * 1000) / limit) + 60 };
  if (conc > 0) lane.cfg = { ...lane.cfg, concurrency: conc };
}

export function isRateLimited(host) {
  return laneFor(host).disabledUntil > Date.now();
}

async function request(url, { as = "json", signal } = {}) {
  const host = new URL(url).host;
  const lane = laneFor(host);
  if (lane.disabledUntil > Date.now()) throw new ProviderError(`${host} is rate-limiting requests`, { status: 429, host });

  const cached = cacheGet(url);
  if (cached) return cached;

  const p = (async () => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await scheduled(host, () => fetch(url, { headers: headersFor(as), signal: timeoutSignal(config.timeoutMs, signal) }));
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < 1) {
          await sleep(600);
          continue;
        }
        throw new ProviderError(`${host} unreachable (${err.name === "TimeoutError" ? "timeout" : err.cause?.code || err.message})`, { host });
      }
      adaptLane(lane, res.headers);
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseFloat(res.headers.get("retry-after")) || 0;
        if (attempt < 2 && retryAfter <= 10) {
          await sleep(Math.max(1500 * (attempt + 1), retryAfter * 1000));
          continue;
        }
        lane.disabledUntil = Date.now() + Math.min(Math.max(retryAfter, 20) * 1000, 15 * 60 * 1000);
        throw new ProviderError(`${host} is rate-limiting requests (HTTP ${res.status})`, { status: res.status, host });
      }
      if (res.status >= 500 && attempt < 1) {
        await sleep(800);
        continue;
      }
      if (!res.ok) throw new ProviderError(`HTTP ${res.status} from ${host}`, { status: res.status, host });
      return as === "json" ? res.json() : res.text();
    }
  })();

  cacheSet(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function splitName(full) {
  const s = String(full || "").trim();
  if (!s) return { given: "", family: "" };
  if (s.includes(",")) {
    const [family, ...rest] = s.split(",");
    return { family: family.trim(), given: rest.join(" ").trim() };
  }
  const parts = s.split(/\s+/);
  return { given: parts.slice(0, -1).join(" "), family: parts.at(-1) };
}

function normType(t) {
  const s = String(t || "").toLowerCase();
  if (/proceedings|conference/.test(s)) return "inproceedings";
  if (/chapter|book-section|book-part|incollection/.test(s)) return "chapter";
  if (/book|monograph/.test(s)) return "book";
  if (/posted-content|preprint/.test(s)) return "preprint";
  if (/dissertation|thesis/.test(s)) return "thesis";
  if (/report/.test(s)) return "report";
  if (/dataset/.test(s)) return "dataset";
  if (/software|computationalnotebook/.test(s)) return "misc";
  return "article";
}

function arxivFromDoi(doi) {
  const m = String(doi || "").match(/^10\.48550\/arxiv\.(.+)$/i);
  return m ? m[1] : null;
}

function record(base) {
  const authors = (base.authors || []).filter((a) => a.family || a.given);
  return {
    source: base.source,
    doi: base.doi ? String(base.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase() : null,
    arxivId: base.arxivId || arxivFromDoi(base.doi),
    title: cleanText(base.title || ""),
    authors,
    year: Number.isFinite(base.year) ? base.year : null,
    container: base.container ? cleanText(base.container) : null,
    volume: base.volume || null,
    issue: base.issue || null,
    pages: base.pages || null,
    publisher: base.publisher ? cleanText(base.publisher) : null,
    type: base.type || "article",
    url: base.url || (base.doi ? `https://doi.org/${base.doi}` : null),
    ...(base.extra || {}),
  };
}

const enc = encodeURIComponent;

function withMailto(url) {
  return config.mailto && IS_NODE ? `${url}${url.includes("?") ? "&" : "?"}mailto=${enc(config.mailto)}` : url;
}

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------

function mapCrossref(it) {
  const dp = it.issued?.["date-parts"]?.[0]?.[0] ?? it["published-print"]?.["date-parts"]?.[0]?.[0] ?? it["published-online"]?.["date-parts"]?.[0]?.[0] ?? it.created?.["date-parts"]?.[0]?.[0];
  return record({
    source: "Crossref",
    doi: it.DOI,
    title: [it.title?.[0], it.subtitle?.[0]].filter(Boolean).join(": "),
    authors: (it.author || it.editor || []).map((a) => ({ given: a.given || "", family: a.family || a.name || "" })),
    year: dp ? Number(dp) : null,
    container: it["container-title"]?.[0] || it["event"]?.name || null,
    volume: it.volume,
    issue: it.issue,
    pages: it.page,
    publisher: it.publisher,
    type: normType(it.type),
  });
}

const CR_SELECT = "DOI,title,subtitle,author,editor,issued,published-print,published-online,container-title,volume,issue,page,publisher,type";

export async function crossrefByDoi(doi, opts) {
  const data = await request(withMailto(`https://api.crossref.org/works/${enc(doi)}`), opts);
  return data?.message ? mapCrossref(data.message) : null;
}

export async function crossrefSearch({ title, author, year }, opts = {}) {
  let url = `https://api.crossref.org/works?rows=${opts.rows || 5}&select=${CR_SELECT}&query.bibliographic=${enc([title, year].filter(Boolean).join(" "))}`;
  if (author) url += `&query.author=${enc(author)}`;
  const data = await request(withMailto(url), opts);
  return (data?.message?.items || []).map(mapCrossref);
}

// ---------------------------------------------------------------------------
// OpenAlex (singleton lookups are free; searches use the daily credit budget)
// ---------------------------------------------------------------------------

function mapOpenAlex(it) {
  const b = it.biblio || {};
  return record({
    source: "OpenAlex",
    doi: it.doi,
    title: it.display_name || it.title || "",
    authors: (it.authorships || []).map((a) => splitName(a.author?.display_name || a.raw_author_name)),
    year: it.publication_year ?? null,
    container: it.primary_location?.source?.display_name || null,
    volume: b.volume,
    issue: b.issue,
    pages: b.first_page && b.last_page && b.first_page !== b.last_page ? `${b.first_page}-${b.last_page}` : b.first_page,
    publisher: it.primary_location?.source?.host_organization_name || null,
    type: normType(it.type),
    url: it.doi || it.primary_location?.landing_page_url || it.id,
  });
}

function openalexUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  let url = `https://api.openalex.org/${path}`;
  if (config.openalexKey) url += `${sep}api_key=${enc(config.openalexKey)}`;
  else if (config.mailto && IS_NODE) url += `${sep}mailto=${enc(config.mailto)}`;
  return url;
}

export async function openalexByDoi(doi, opts) {
  const data = await request(openalexUrl(`works/doi:${enc(doi)}`), opts);
  return data?.id ? mapOpenAlex(data) : null;
}

export async function openalexSearch({ title }, opts = {}) {
  const clean = String(title || "").replace(/[,:|!]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const data = await request(openalexUrl(`works?per-page=${opts.rows || 5}&search=${enc(clean)}`), opts);
  return (data?.results || []).map(mapOpenAlex);
}

// ---------------------------------------------------------------------------
// DataCite (arXiv, Zenodo, figshare, institutional repositories) + doi.org
// ---------------------------------------------------------------------------

const DC_TYPES = { Preprint: "preprint", ConferencePaper: "inproceedings", ConferenceProceeding: "inproceedings", Book: "book", BookChapter: "chapter", Dissertation: "thesis", Report: "report", Dataset: "dataset", Software: "misc", JournalArticle: "article", Text: "article" };

function mapDataCite(d) {
  const a = d.attributes || {};
  const doi = a.doi || d.id;
  const arxivId = arxivFromDoi(doi);
  const publisher = typeof a.publisher === "object" ? a.publisher?.name : a.publisher;
  return record({
    source: arxivId ? "arXiv (DataCite)" : "DataCite",
    doi,
    arxivId,
    title: a.titles?.find((t) => !t.titleType)?.title || a.titles?.[0]?.title || "",
    authors: (a.creators || []).map((c) => (c.familyName ? { family: c.familyName, given: c.givenName || "" } : c.nameType === "Organizational" ? { family: c.name, given: "" } : splitName(c.name))),
    year: a.publicationYear ? Number(a.publicationYear) : null,
    container: a.container?.title || (arxivId ? "arXiv" : null),
    volume: a.container?.volume,
    issue: a.container?.issue,
    pages: a.container?.firstPage && a.container?.lastPage ? `${a.container.firstPage}-${a.container.lastPage}` : a.container?.firstPage,
    publisher,
    type: arxivId ? "preprint" : DC_TYPES[a.types?.resourceTypeGeneral] || normType(a.types?.resourceTypeGeneral),
    url: arxivId ? `https://arxiv.org/abs/${arxivId}` : a.url || `https://doi.org/${doi}`,
  });
}

export async function dataciteByDoi(doi, opts) {
  const data = await request(`https://api.datacite.org/dois/${enc(doi)}`, opts);
  return data?.data ? mapDataCite(data.data) : null;
}

const luceneClean = (s) => String(s || "").replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").replace(/\b(?:AND|OR|NOT)\b/g, " ").replace(/\s+/g, " ").trim();

export async function dataciteSearch({ title, author }, opts = {}) {
  const t = luceneClean(title);
  if (!t) return [];
  let q = `titles.title:(${t})`;
  const a = luceneClean(author);
  if (a) q += ` AND creators.familyName:(${a})`;
  const extra = opts.preprintsOnly ? "&resource-type-id=preprint" : "";
  const data = await request(`https://api.datacite.org/dois?page[size]=${opts.rows || 5}${extra}&query=${enc(q)}`, opts);
  return (data?.data || []).map(mapDataCite);
}

// true = DOI is registered, false = not registered anywhere, throws if unknown
export async function doiIsRegistered(doi, opts) {
  const data = await request(`https://doi.org/api/handles/${enc(doi)}`, opts);
  if (data === null) return false;
  return data.responseCode === 1;
}

// ---------------------------------------------------------------------------
// arXiv (Atom API is server-only: it does not send CORS headers)
// ---------------------------------------------------------------------------

function xmlTag(entry, name) {
  const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? cleanText(m[1]) : null;
}

function mapArxiv(entry) {
  const id = (entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/) || [])[1]?.replace(/v\d+$/, "") || null;
  if (!id) return null;
  const published = xmlTag(entry, "published") || "";
  return record({
    source: "arXiv",
    arxivId: id,
    doi: (entry.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/) || [])[1] || null,
    title: xmlTag(entry, "title") || "",
    authors: [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => splitName(cleanText(m[1]))),
    year: /^\d{4}/.test(published) ? parseInt(published.slice(0, 4), 10) : null,
    container: xmlTag(entry, "arxiv:journal_ref") || "arXiv",
    type: "preprint",
    url: `https://arxiv.org/abs/${id}`,
  });
}

export async function arxivById(id, opts) {
  const clean = String(id).replace(/^arxiv:\s*/i, "").replace(/v\d+$/i, "").trim();
  if (IS_NODE) {
    try {
      const xml = await request(`https://export.arxiv.org/api/query?id_list=${enc(clean)}&max_results=1`, { ...opts, as: "xml" });
      if (xml) {
        const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
        const rec = entry ? mapArxiv(entry[1]) : null;
        if (rec) return rec;
      }
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      // fall through to DataCite, which mirrors arXiv metadata
    }
  }
  return dataciteByDoi(`10.48550/arXiv.${clean}`, opts);
}

export async function arxivSearch({ title }, opts = {}) {
  const words = luceneClean(title).split(" ").filter((w) => w.length > 2).slice(0, 10);
  if (!words.length) return [];
  if (!IS_NODE) return dataciteSearch({ title, author: opts.author }, { ...opts, preprintsOnly: true });
  const q = words.map((w) => `ti:${w}`).join(" AND ");
  const xml = await request(`https://export.arxiv.org/api/query?search_query=${enc(q)}&max_results=${opts.rows || 4}`, { ...opts, as: "xml" });
  return [...String(xml || "").matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => mapArxiv(m[1])).filter(Boolean);
}

// ---------------------------------------------------------------------------
// PubMed (NCBI E-utilities)
// ---------------------------------------------------------------------------

function pubmedName(n) {
  const parts = String(n || "").trim().split(/\s+/);
  if (parts.length > 1 && /^[A-Z]{1,4}$/.test(parts.at(-1))) return { family: parts.slice(0, -1).join(" "), given: parts.at(-1).split("").join(". ") + "." };
  return splitName(n);
}

function ncbi(path) {
  let url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${path}&tool=veribib`;
  if (config.mailto && IS_NODE) url += `&email=${enc(config.mailto)}`;
  return url;
}

async function pubmedSummaries(ids, opts) {
  if (!ids.length) return [];
  const summary = await request(ncbi(`esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`), opts);
  return ids
    .map((id) => summary?.result?.[id])
    .filter((r) => r && r.title)
    .map((r) =>
      record({
        source: "PubMed",
        doi: r.articleids?.find((x) => x.idtype === "doi")?.value || null,
        title: String(r.title).replace(/\.$/, ""),
        authors: (r.authors || []).filter((a) => a.authtype !== "CollectiveName" || a.name).map((a) => pubmedName(a.name)),
        year: (r.pubdate || "").match(/\d{4}/) ? parseInt(r.pubdate.match(/\d{4}/)[0], 10) : null,
        container: r.fulljournalname || r.source || null,
        volume: r.volume,
        issue: r.issue,
        pages: r.pages,
        type: "article",
        url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`,
        extra: { pmid: r.uid },
      })
    );
}

export async function pubmedSearch({ title }, opts = {}) {
  const t = String(title || "").replace(/[[\]()"]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const search = await request(ncbi(`esearch.fcgi?db=pubmed&retmode=json&retmax=3&term=${enc(`${t}[Title]`)}`), opts);
  return pubmedSummaries(search?.esearchresult?.idlist || [], opts);
}

export async function pubmedById(pmid, opts) {
  return (await pubmedSummaries([String(pmid)], opts))[0] || null;
}

// ---------------------------------------------------------------------------
// Google Books
// ---------------------------------------------------------------------------

function mapBook(it) {
  const v = it.volumeInfo || {};
  const isbn = (v.industryIdentifiers || []).find((x) => x.type === "ISBN_13")?.identifier || (v.industryIdentifiers || [])[0]?.identifier;
  return record({
    source: "Google Books",
    title: [v.title, v.subtitle].filter(Boolean).join(": "),
    authors: (v.authors || []).map(splitName),
    year: /^\d{4}/.test(v.publishedDate || "") ? parseInt(v.publishedDate.slice(0, 4), 10) : null,
    publisher: v.publisher,
    type: "book",
    url: v.infoLink || v.previewLink || null,
    extra: { isbn: isbn || null },
  });
}

export async function googleBooksSearch({ title, author, isbn }, opts = {}) {
  const q = isbn ? `isbn:${isbn}` : [title && `intitle:${title}`, author && `inauthor:${author}`].filter(Boolean).join("+");
  if (!q) return [];
  const data = await request(`https://www.googleapis.com/books/v1/volumes?maxResults=5&q=${enc(q)}`, opts);
  return (data?.items || []).map(mapBook);
}

// ---------------------------------------------------------------------------
// Live web pages (blogs, docs, project pages)
// ---------------------------------------------------------------------------

function isPrivateAddress(ip) {
  if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(ip)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe80:/.test(v6) || /^::ffff:(?:127|10|192\.168)\./.test(v6);
}

const viaProxy = () => IS_NODE && process.env.NODE_USE_ENV_PROXY === "1" && !!(process.env.HTTPS_PROXY || process.env.https_proxy);

// Refuse to fetch internal addresses on the server (SSRF guard).
async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host) || isPrivateAddress(host)) throw Object.assign(new Error("private address"), { code: "PRIVATE" });
  const { lookup } = await import("node:dns/promises");
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) throw Object.assign(new Error("private address"), { code: "PRIVATE" });
  } catch (err) {
    if (err.code === "PRIVATE") throw err;
    if (!viaProxy()) throw Object.assign(new Error("domain does not resolve"), { code: "ENOTFOUND" });
  }
}

function parseMeta(html) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? "";
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (key && attrs.content != null) (meta[key] ||= []).push(cleanText(attrs.content));
  }
  return meta;
}

async function readCapped(res, max = 600_000) {
  if (!res.body?.getReader) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= max) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    buf.set(c.subarray(0, Math.min(c.length, size - o)), o);
    o += c.length;
    if (o >= size) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// Result: { ok: true|false|null, url, host, status?, title?, authors?, year?, siteName?, text?, reason, inspected }
export async function inspectWebPage(rawUrl, { signal } = {}) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return { ok: false, url: rawUrl, host: "", reason: "Malformed URL", inspected: false };
  }
  const host = url.hostname.replace(/^www\./, "");

  if (!IS_NODE) {
    // Browsers block cross-origin reads, so only reachability can be tested.
    if (url.protocol === "http:" && globalThis.location?.protocol === "https:") {
      return { ok: null, url: url.href, host, reason: "Plain-HTTP link cannot be checked from a secure page", inspected: false };
    }
    try {
      await fetch(url.href, { mode: "no-cors", cache: "no-store", signal: timeoutSignal(9000, signal), referrerPolicy: "no-referrer" });
      return { ok: true, url: url.href, host, reason: "Host responded", inspected: false };
    } catch (err) {
      if (signal?.aborted) throw err;
      return { ok: false, url: url.href, host, reason: "Host did not respond (domain may not exist)", inspected: false, dead: true };
    }
  }

  const cacheKey = `web:${url.href}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const p = (async () => {
    let current = url;
    try {
      for (let hop = 0; hop < 6; hop++) {
        await assertPublicHost(current.hostname);
        const res = await fetch(current.href, {
          redirect: "manual",
          signal: timeoutSignal(10000, signal),
          headers: {
            "User-Agent": `Mozilla/5.0 (compatible; ${config.userAgent})`,
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en;q=0.9,*;q=0.5",
          },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          current = new URL(res.headers.get("location"), current);
          if (!/^https?:$/.test(current.protocol)) break;
          continue;
        }
        const base = { url: current.href, host, status: res.status, inspected: true };
        if (res.status === 404 || res.status === 410) return { ...base, ok: false, dead: true, reason: `Page not found (HTTP ${res.status})` };
        if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 451)
          return { ...base, ok: null, inspected: false, reason: `Site blocks automated checks (HTTP ${res.status})` };
        if (res.status >= 500) return { ...base, ok: null, inspected: false, reason: `Server error (HTTP ${res.status})` };
        if (!res.ok) return { ...base, ok: false, reason: `HTTP ${res.status}` };

        const type = res.headers.get("content-type") || "";
        if (!/html|xml/i.test(type)) {
          return { ...base, ok: true, inspected: false, reason: `Reachable (${type.split(";")[0] || "file"})`, title: decodeURIComponent(current.pathname.split("/").pop() || "") };
        }
        const html = await readCapped(res);
        const meta = parseMeta(html);
        const first = (...k) => {
          for (const x of k) if (meta[x]?.[0]) return meta[x][0];
          return "";
        };
        const rawTitle = first("citation_title", "dc.title", "og:title", "twitter:title") || cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
        const siteName = first("og:site_name", "application-name") || host;
        const authorNames = [...(meta.citation_author || []), ...(meta.author || []), ...(meta["article:author"] || []), ...(meta["dc.creator"] || [])].filter((a) => a && !/^https?:/.test(a));
        const dateStr = first("citation_publication_date", "citation_date", "article:published_time", "dc.date", "date", "og:updated_time") || (html.match(/"datePublished"\s*:\s*"(\d{4})/) || [])[1] || "";
        const year = (dateStr.match(/(?:19|20)\d{2}/) || current.pathname.match(/\b(20[0-3]\d)\b/) || [])[0];
        const text = cleanText(
          html
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
        ).slice(0, 60000);
        return {
          ...base,
          ok: true,
          reason: `Reachable (HTTP ${res.status})`,
          title: rawTitle,
          siteName,
          authors: [...new Set(authorNames)].slice(0, 12).map(splitName),
          year: year ? parseInt(year, 10) : null,
          text,
        };
      }
      return { ok: false, url: current.href, host, reason: "Too many redirects", inspected: false };
    } catch (err) {
      if (signal?.aborted) throw err;
      const code = err.code || err.cause?.code || "";
      if (code === "PRIVATE") return { ok: false, url: current.href, host, reason: "Refused: private network address", inspected: false };
      if (code === "ENOTFOUND" || /ENOTFOUND|EAI_AGAIN/.test(String(err.cause?.message || err.message)))
        return { ok: false, url: current.href, host, dead: true, reason: "Domain does not exist (DNS lookup failed)", inspected: false };
      if (err.name === "TimeoutError") return { ok: null, url: current.href, host, reason: "Site timed out", inspected: false };
      return { ok: false, url: current.href, host, dead: !viaProxy(), reason: `Unreachable (${code || err.message})`, inspected: false };
    }
  })();
  cacheSet(cacheKey, p);
  return p;
}

export function webRecord(page, entry) {
  if (!page || page.ok !== true || !page.inspected) return null;
  const title = page.title ? page.title.split(/\s+[|·•»–—-]\s+(?=[^|·•»–—-]{2,60}$)/)[0].trim() : "";
  return record({
    source: `Web · ${page.siteName || page.host}`,
    title: title || page.title || "",
    authors: page.authors || [],
    year: page.year,
    container: page.siteName || page.host,
    publisher: page.siteName || page.host,
    type: "web",
    url: page.url,
    extra: { siteName: page.siteName || page.host, web: { status: page.status ?? null, inspected: page.inspected, host: page.host, textHasAuthor: entryAuthorInText(page.text, entry) } },
  });
}

function entryAuthorInText(text, entry) {
  if (!text || !entry?.surnames?.length) return null;
  const hay = ` ${text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")} `;
  return entry.surnames.some((s) => new RegExp(`[^a-z]${s.replace(/[^a-z0-9]/g, "")}[^a-z]`).test(hay));
}

// Test hook: clear caches/limits and (optionally) disable throttling.
export function __resetForTests({ noThrottle = true } = {}) {
  cache.clear();
  lanes.clear();
  if (noThrottle) for (const k of Object.keys(HOST_LIMITS)) HOST_LIMITS[k] = { concurrency: 8, interval: 0 };
}
