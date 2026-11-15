// Keyless academic API clients: Crossref, OpenAlex, arXiv, PubMed, Google Books.
// Each lookup returns a normalized work or null; network/5xx failures throw so
// callers can distinguish "not found" from "provider unreachable".

const UA = "BibCheck/1.0 (https://github.com/bibcheck; mailto:bibcheck@example.org)";
const TIMEOUT_MS = 12000;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { given: "", family: "" };
  return { given: parts.slice(0, -1).join(" "), family: parts.at(-1) };
}

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------

function mapCrossref(it) {
  const year =
    it?.issued?.["date-parts"]?.[0]?.[0] ??
    it?.created?.["date-parts"]?.[0]?.[0] ??
    null;
  const authors = (it.author || []).map((a) => ({
    given: a.given || "",
    family: a.family || a.name || "",
  }));
  return {
    source: "Crossref",
    doi: it.DOI || null,
    title: [it.title?.[0], it.subtitle?.[0]].filter(Boolean).join(": "),
    authors,
    surnames: authors.map((a) => a.family.toLowerCase()).filter(Boolean),
    year,
    container: it["container-title"]?.[0] || null,
    volume: it.volume || null,
    issue: it.issue || null,
    pages: it.page || null,
    publisher: it.publisher || null,
    type: it.type || null,
    url: it.DOI ? `https://doi.org/${it.DOI}` : it.URL || null,
  };
}

export async function crossrefByDoi(doi) {
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from api.crossref.org`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return mapCrossref(data.message);
}

export async function crossrefSearch(query, rows = 5) {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}`;
  const data = await getJson(url);
  return (data.message?.items || []).map(mapCrossref);
}

// ---------------------------------------------------------------------------
// OpenAlex
// ---------------------------------------------------------------------------

function mapOpenAlex(it) {
  const authors = (it.authorships || []).map((a) => splitName(a.author?.display_name));
  return {
    source: "OpenAlex",
    doi: it.doi ? it.doi.replace(/^https?:\/\/doi\.org\//, "") : null,
    title: it.display_name || it.title || "",
    authors,
    surnames: authors.map((a) => a.family.toLowerCase()).filter(Boolean),
    year: it.publication_year ?? null,
    container: it.primary_location?.source?.display_name || null,
    volume: it.biblio?.volume || null,
    issue: it.biblio?.issue || null,
    pages:
      it.biblio?.first_page && it.biblio?.last_page
        ? `${it.biblio.first_page}-${it.biblio.last_page}`
        : it.biblio?.first_page || null,
    publisher: it.primary_location?.source?.publisher || null,
    type: it.type || null,
    url: it.doi || (it.id ? `https://openalex.org/${it.id.replace(/^https:\/\/openalex\.org\//, "")}` : null),
  };
}

export async function openalexByDoi(doi) {
  try {
    const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, "").trim();
    const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(cleanDoi)}?mailto=bibcheck@example.org`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return mapOpenAlex(data);
  } catch (err) {
    return null;
  }
}

export async function openalexSearch(query, perPage = 5) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${perPage}&mailto=bibcheck@example.org`;
  const data = await getJson(url);
  return (data.results || []).map(mapOpenAlex);
}

// ---------------------------------------------------------------------------
// arXiv (Atom XML)
// ---------------------------------------------------------------------------

function tag(entry, name) {
  const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function mapArxiv(entry) {
  const id = (entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/) || [])[1] || null;
  const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => splitName(m[1]));
  return {
    source: "arXiv",
    doi: (entry.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/) || [])[1] || null,
    title: tag(entry, "title") || "",
    authors,
    surnames: authors.map((a) => a.family.toLowerCase()).filter(Boolean),
    year: (tag(entry, "published") || "").slice(0, 4) ? parseInt(tag(entry, "published").slice(0, 4), 10) : null,
    container: (entry.match(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/) || [])[1] || "arXiv preprint",
    volume: null,
    issue: null,
    pages: null,
    publisher: null,
    type: "preprint",
    url: id ? `https://arxiv.org/abs/${id}` : null,
  };
}

export async function arxivById(id) {
  const cleanId = id.replace(/^arxiv:\s*/i, "").replace(/v\d+$/i, "").trim();
  const xml = await getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}&max_results=1`);
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entry) return null;
  return mapArxiv(entry[1]);
}

export async function arxivSearch(query, maxResults = 3) {
  try {
    const cleanQuery = query.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleanQuery) return [];
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(cleanQuery)}&max_results=${maxResults}`;
    const xml = await getText(url);
    const matches = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    return matches.map((m) => mapArxiv(m[1])).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// PubMed
// ---------------------------------------------------------------------------

export async function pubmedSearch(title) {
  const term = `${title}[Title]`;
  const search = await getJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmode=json&retmax=3`
  );
  const ids = search.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const summary = await getJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`
  );
  const out = [];
  for (const id of ids) {
    const r = summary.result?.[id];
    if (!r) continue;
    const year = (r.pubdate || "").match(/(\d{4})/)?.[1];
    const authors = (r.authors || []).map((a) => splitName(a.name));
    out.push({
      source: "PubMed",
      doi: r.articleids?.find((x) => x.idtype === "doi")?.value || null,
      title: r.title || "",
      authors,
      surnames: authors.map((a) => a.family.toLowerCase()).filter(Boolean),
      year: year ? parseInt(year, 10) : null,
      container: r.source || null,
      volume: r.volume || null,
      issue: r.issue || null,
      pages: r.pages || null,
      publisher: null,
      type: "journal-article",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Web / Blog Live Verification (for @misc, blogs, docs, online resources)
// ---------------------------------------------------------------------------

function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .trim();
}

export async function verifyWebResource(rawUrl) {
  try {
    let target = rawUrl.trim();
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    const urlObj = new URL(target);

    // Skip localhost or invalid hosts
    if (urlObj.hostname === "localhost" || urlObj.hostname === "127.0.0.1") return null;

    const res = await fetch(urlObj.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BibCheck/1.0 (academic citation verifier)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });

    if (res.status === 404 || res.status === 410) {
      return {
        ok: false,
        source: `Web (${urlObj.hostname})`,
        url: urlObj.href,
        statusCode: res.status,
        error: `Page Not Found (HTTP ${res.status} Dead Link)`,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        source: `Web (${urlObj.hostname})`,
        url: urlObj.href,
        statusCode: res.status,
        error: `HTTP ${res.status} Error`,
      };
    }

    const html = (await res.text()).slice(0, 80000);

    const titleM =
      html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+name=["']twitter:title["']\s+content=["']([^"']+)["']/i) ||
      html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const rawTitle = titleM ? decodeHtmlEntities(titleM[1]) : "";
    // Clean up site suffix if present (e.g. "Page Title | Site Name")
    const pageTitle = rawTitle.split(/\s+[|\-–—]\s+[A-Za-z0-9]/)[0].trim() || rawTitle;

    const siteM = html.match(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i);
    const siteName = siteM ? decodeHtmlEntities(siteM[1]) : urlObj.hostname.replace(/^www\./, "");

    const authorM =
      html.match(/<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i) ||
      html.match(/<meta\s+property=["']article:author["']\s+content=["']([^"']+)["']/i);
    const authorStr = authorM ? decodeHtmlEntities(authorM[1]) : "";

    const dateM =
      html.match(/<meta\s+property=["']article:published_time["']\s+content=["'](\d{4})[^"']*["']/i) ||
      urlObj.pathname.match(/\b(20[12]\d)\b/);
    const year = dateM ? parseInt(dateM[1], 10) : null;

    return {
      ok: true,
      source: `Web (${siteName})`,
      url: res.url || urlObj.href,
      statusCode: res.status,
      title: pageTitle || rawTitle || `Web page on ${siteName}`,
      siteName,
      authors: authorStr ? [splitName(authorStr)] : [],
      surnames: authorStr ? [authorStr.toLowerCase().split(/\s+/).pop()] : [],
      year,
      container: siteName,
      volume: null,
      issue: null,
      pages: null,
      publisher: siteName,
      type: "misc",
    };
  } catch (err) {
    return {
      ok: false,
      source: "Web",
      url: rawUrl,
      error: `Unreachable URL (${err.message})`,
    };
  }
}

export async function googleBooksSearch(query) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429 || res.status === 403) return []; // quota exceeded, treat as no data
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from books.google.com`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const authors = (v.authors || []).map(splitName);
    return {
      source: "Google Books",
      doi: null,
      title: [v.title, v.subtitle].filter(Boolean).join(": "),
      authors,
      surnames: authors.map((a) => a.family.toLowerCase()).filter(Boolean),
      year: v.publishedDate ? parseInt(v.publishedDate.slice(0, 4), 10) : null,
      container: null,
      volume: null,
      issue: null,
      pages: v.pageCount ? String(v.pageCount) : null,
      publisher: v.publisher || null,
      type: "book",
      url: v.previewLink || v.infoLink || null,
    };
  });
}
