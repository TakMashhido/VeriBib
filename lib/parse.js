// Parse a raw bibliography: split into entries, guess citation style, extract fields.
// Supports APA, MLA, Chicago, IEEE, Harvard, Vancouver, BibTeX, and RIS.

const MARKER_RE = /^\s*[\[\(]?(\d{1,3})[\]\).:]\s+/;

// A line "starts a new entry" if it looks like an author-list opening:
// "Surname, F.", "F. Surname" (IEEE), "Surname F," (Vancouver/Harvard).
const AUTHOR_START_RES = [
  /^[A-Z][A-Za-z''’\-]+,\s*[A-Z]/,
  /^[A-Z]\.\s*[A-Z][A-Za-z''’\-]+/,
  /^[A-Z][A-Za-z''’\-]+\s+[A-Z][\.\s,]/,
  /^[A-Z][A-Za-z''’\-]+,?\s+(?:and|&)\s+/i,
];

function looksLikeEntryStart(line) {
  return AUTHOR_START_RES.some((re) => re.test(line));
}

// Split BibTeX blocks (@article{key, ... })
function splitBibTeX(text) {
  const entries = [];
  const re = /@([a-zA-Z]+)\s*\{([^,]*),/g;
  let match;
  const indices = [];

  while ((match = re.exec(text)) !== null) {
    indices.push(match.index);
  }

  if (!indices.length) return [];

  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : text.length;
    const block = text.slice(start, end).trim();
    if (block) entries.push(block);
  }
  return entries;
}

// Split RIS blocks (TY  - ... ER  - )
function splitRIS(text) {
  const blocks = text.split(/(?:^|\n)ER\s*-(?:[ \t]*\n|$)/);
  return blocks.map((b) => b.trim()).filter((b) => /TY\s*-/.test(b));
}

export function splitReferences(text) {
  const clean = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];

  // 1. Check for BibTeX
  if (/^@[a-zA-Z]+\s*\{/m.test(clean)) {
    const bibtexEntries = splitBibTeX(clean);
    if (bibtexEntries.length > 0) return bibtexEntries;
  }

  // 2. Check for RIS
  if (/^TY\s*-/m.test(clean)) {
    const risEntries = splitRIS(clean);
    if (risEntries.length > 0) return risEntries;
  }

  const lines = clean.split("\n").filter((l) => l.trim());
  if (!lines.length) return [];

  // 3. Numbered markers (e.g. [1], 1., (1))
  const markerIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (MARKER_RE.test(lines[i])) {
      markerIndices.push(i);
    }
  }

  if (markerIndices.length >= 1) {
    const entries = [];
    let current = [];
    const flush = () => {
      if (current.length) entries.push(current.join(" ").replace(/\s+/g, " ").trim());
      current = [];
    };
    for (const line of lines) {
      if (MARKER_RE.test(line)) {
        flush();
        current.push(line.replace(MARKER_RE, "").trim());
      } else {
        current.push(line.trim());
      }
    }
    flush();
    if (entries.length > 0) return entries;
  }

  // 4. Double-newline paragraph separated references
  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length >= 2) return paragraphs;

  // 5. Line-by-line fallback with wrapped continuation merging
  const entries = [];
  let current = "";
  for (const line of lines) {
    const t = line.trim();
    if (!current) {
      current = t;
      continue;
    }
    const startsNew =
      MARKER_RE.test(t) ||
      (/[.!?)"\]]$/.test(current) &&
        !/doi\.org\/\S*$/i.test(current) &&
        looksLikeEntryStart(t));
    if (startsNew) {
      entries.push(current);
      current = t;
    } else {
      current = `${current} ${t}`;
    }
  }
  if (current) entries.push(current);

  // Single physical line holding several references
  if (entries.length === 1) {
    const one = entries[0];
    const multiComma =
      one.match(/(?:19|20)\d{2}[a-z]?\)?[.;]?\s+[A-Z][A-Za-z''’\-]+,\s*[A-Z]/g)?.length || 0;
    const multiVanc = one.match(/(?:19|20)\d{2};\s*\d+[^;]*\.\s*[A-Z][A-Za-z''’\-]+\s+[A-Z]{1,3}[.,]/g)?.length || 0;
    if (multiComma >= 2 || multiVanc >= 2) {
      const parts = one
        .split(/(?<=[.;”"])\s+(?=[A-Z][A-Za-z''’\-]+(?:,\s*[A-Z]|\s+[A-Z]{1,3}[.,]))/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 1) return parts;
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Style detection
// ---------------------------------------------------------------------------

export function detectStyle(text) {
  const t = String(text || "");
  const s = { apa: 0, mla: 0, chicago: 0, ieee: 0, harvard: 0, vancouver: 0, bibtex: 0 };
  if (/^@[a-zA-Z]+\s*\{/m.test(t)) s.bibtex += 6;
  if (MARKER_RE.test(t)) s.ieee += 3;
  if (/\((?:19|20)\d{2}[a-z]?(?:,\s*[^)]+)?\)/.test(t)) s.apa += 2;
  if (/["“][^"”]{15,300}["”]/.test(t)) s.mla += 2;
  if (/^[A-Z][A-Za-z''’\-]+ [A-Z]{1,3}[.,]/.test(t.trim())) s.vancouver += 2;
  if (/\b(?:19|20)\d{2}\s*;\s*\d+\s*(?:\(|:)/.test(t)) s.vancouver += 2;
  if (/\b[A-Z][A-Za-z''’\-\. ]{2,60}:\s*[A-Z][^,.;]{2,60},\s*(?:19|20)\d{2}/.test(t)) s.chicago += 2;
  if (/\(\d{4}\)\.?\s*[''“‘]/.test(t)) s.harvard += 2;
  if (/\bvol\.\s*\d+/i.test(t)) s.mla += 1;
  if (/\d+\s*\(\d+\)\s*,?\s*\d+\s*[–\-]/.test(t)) s.apa += 1;
  if (/\bet al\.?/i.test(t)) s.apa += 0.5;
  if (/\bdoi:/i.test(t)) s.ieee += 0.5;
  if (/https?:\/\/doi\.org\//i.test(t)) {
    s.apa += 0.5;
    s.harvard += 0.5;
  }
  if (/\bpp\.\s*\d+/i.test(t)) {
    s.ieee += 0.5;
    s.apa += 0.25;
  }
  return s;
}

export function detectEntryStyle(text) {
  const s = detectStyle(text);
  let best = "unknown";
  let bestScore = 0.5;
  let total = 0;
  for (const [k, v] of Object.entries(s)) {
    total += v;
    if (v > bestScore) {
      best = k;
      bestScore = v;
    }
  }
  const confidence = total ? Math.min(0.95, bestScore / total + (total >= 3 ? 0.2 : 0)) : 0;
  return { style: best, confidence: Math.round(confidence * 100) / 100 };
}

export function detectBibliography(text) {
  const entries = splitReferences(text);
  const agg = { apa: 0, mla: 0, chicago: 0, ieee: 0, harvard: 0, vancouver: 0, bibtex: 0 };
  for (const e of entries) {
    const s = detectStyle(e);
    for (const k in agg) agg[k] += s[k] || 0;
  }
  let style = "unknown";
  let best = 0;
  let total = 0;
  for (const [k, v] of Object.entries(agg)) {
    total += v;
    if (v > best) {
      style = k;
      best = v;
    }
  }
  const confidence = total ? Math.round(Math.min(0.95, best / total) * 100) / 100 : 0;
  return {
    count: entries.length,
    style,
    confidence,
    entryStyles: entries.map((e) => detectEntryStyle(e)),
  };
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function stripTrailing(s) {
  return String(s || "").replace(/[.,;:)\]]+$/, "");
}

function quotedTitle(text) {
  const m = text.match(/[“"]([^“”"]{10,300})[”"][\s.,]*/);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

// Split into sentence-ish chunks at ". " boundaries, skipping initials and abbrevs
function chunkSplit(text) {
  const chunks = [];
  let start = 0;
  const re = /[.!?]\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(start, m.index);
    const lastWord = (before.match(/([^\s.]+)$/) || [])[1] || "";
    if (/^[A-Z]$/.test(lastWord)) continue;
    if (/^(?:al|eg|ie|cf|vs|ca|no|pp|p|ed|eds|vol|jr|sr|st|mr|ms|mrs|dr|prof|inc|ltd|co|fig|eq)$/i.test(lastWord)) continue;
    chunks.push(text.slice(start, m.index + 1).replace(/\s+/g, " ").trim());
    start = m.index + m[0].length;
  }
  if (start < text.length) chunks.push(text.slice(start).replace(/\s+/g, " ").trim());
  return chunks.filter(Boolean);
}

function extractYear(text) {
  const paren = text.match(/\((\d{4})[a-z]?(?:[,\s][^)]*)?\)/);
  if (paren) return parseInt(paren[1], 10);
  const vanc = text.match(/\b(1[89]\d{2}|20[0-3]\d)\s*;/);
  if (vanc) return parseInt(vanc[1], 10);

  // Check end of string for IEEE-like "... 2017."
  const endYear = text.match(/\b(1[89]\d{2}|20[0-3]\d)[.\s]*$/);
  if (endYear) return parseInt(endYear[1], 10);

  for (const m of text.matchAll(/\b(1[89]\d{2}|20[0-3]\d)\b/g)) {
    const y = parseInt(m[1], 10);
    const before = text.slice(Math.max(0, m.index - 3), m.index);
    if (/[:\-–]\s*$/.test(before)) continue; // page-range endpoint
    return y;
  }
  return null;
}

// Find where the author list ends and the rest begins.
function splitAuthors(text) {
  const parenM = text.match(/^([\s\S]{3,220}?)\s*\((?:\d{4}|n\.d\.)[a-z]?[^)]*\)[.,:]?\s*/);
  if (parenM) {
    return {
      authorsRaw: parenM[1].replace(/[\s,]+$/, ""),
      afterAuthors: text.slice(parenM[0].length),
      mode: "year-paren",
    };
  }
  const qM = text.match(/^([\s\S]{0,220}?)["“]/);
  if (qM && /,/.test(qM[1])) {
    return {
      authorsRaw: qM[1].replace(/[\s,]+$/, ""),
      afterAuthors: text.slice(qM[1].length),
      mode: "quoted",
    };
  }
  const chunks = chunkSplit(text);
  const first = chunks[0] || "";
  const looksLikeAuthors =
    first.length > 2 &&
    first.length < 220 &&
    (/,\s/.test(first) || /\b[A-Z]\.\s/.test(first) || /^[A-Z][A-Za-z''’\-]+ [A-Z]{1,3}[.,]/.test(first)) &&
    !/\b(?:19|20)\d{2}/.test(first.slice(0, 30));
  if (looksLikeAuthors) {
    return {
      authorsRaw: first.replace(/\.$/, ""),
      afterAuthors: text.slice(text.indexOf(first) + first.length).replace(/^[\s.]+/, ""),
      mode: "chunk",
    };
  }
  return { authorsRaw: null, afterAuthors: text, mode: "none" };
}

export function extractSurnames(authorsRaw) {
  if (!authorsRaw) return [];
  const text = String(authorsRaw)
    .replace(/\bet al\.?/gi, "")
    .replace(/&/g, " and ")
    .trim();

  // Pattern 1: Surname, Initials or Surname, Given (e.g. Vaswani, A. or Vaswani, Ashish)
  const r1 = [...text.matchAll(/([A-Z][A-Za-z''’\-]+)\s*,\s*(?:[A-Z]\.?|[A-Z][a-z]+)/g)].map((m) =>
    m[1].toLowerCase()
  );

  // Pattern 2: Initials Surname (e.g. A. Vaswani or J. R. Smith)
  const r2 = [...text.matchAll(/(?:[A-Z]\.\s*)+([A-Z][A-Za-z''’\-]+)/g)].map((m) => m[1].toLowerCase());

  let combined = [...new Set([...r1, ...r2])];

  // Fallback: split by 'and' or commas and take the last word
  if (combined.length === 0) {
    const parts = text.split(/\s+and\s+|[,;]/i);
    for (const p of parts) {
      const words = p
        .replace(/[^\p{L}\p{M}''’\- ]/gu, "")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !/^(?:van|von|de|der|del|della|da|di|du|bin|al|el|ibn|ben)$/i.test(w));
      if (words.length) {
        const s = words[words.length - 1].toLowerCase();
        if (!combined.includes(s)) combined.push(s);
      }
    }
  }

  return combined;
}

// Extract fields from BibTeX entry
function parseBibTeXFields(text) {
  const f = { raw: text, format: "bibtex" };
  const typeM = text.match(/@([a-zA-Z]+)\s*\{([^,\s]+),?/);
  if (typeM) {
    f.type = typeM[1].toLowerCase();
    f.citeKey = typeM[2];
  }

  const getField = (name) => {
    const re = new RegExp(`\\b${name}\\s*=\\s*[{"]([^}"]+)[}"]|\\b${name}\\s*=\\s*([0-9]+)`, "i");
    const m = text.match(re);
    return m ? (m[1] || m[2]).trim() : null;
  };

  f.title = getField("title");
  f.authorsRaw = getField("author");
  f.year = getField("year") ? parseInt(getField("year"), 10) : null;
  f.doi = getField("doi") ? stripTrailing(getField("doi")) : null;
  f.venue = getField("journal") || getField("booktitle") || getField("archiveprefix") || null;
  f.volume = getField("volume");
  f.issue = getField("number") || getField("issue");
  f.pages = getField("pages");
  f.publisher = getField("publisher") || getField("institution") || getField("organization");

  // Extract URL from url, howpublished, or note fields (common in @misc blogs)
  const howpub = getField("howpublished") || getField("note") || "";
  const urlField = getField("url");
  const extractedUrl = urlField || (howpub.match(/https?:\/\/[^\s,"'>{}]+/i) || [])[0] || null;
  if (extractedUrl) {
    f.url = stripTrailing(extractedUrl.replace(/\\url\{([^}]+)\}/i, "$1").replace(/[{}]/g, ""));
  }

  const eprint = getField("eprint");
  if (eprint) {
    const arClean = eprint.replace(/^arxiv:\s*/i, "").replace(/v\d+$/i, "");
    if (/^\d{4}\.\d{4,5}$/.test(arClean) || /^[a-z\-]+\/\d{7}$/.test(arClean)) {
      f.arxivId = arClean;
    }
  }

  if (f.type === "misc" || f.type === "online" || f.type === "software" || f.type === "web") {
    f.type = "misc";
    if (!f.venue && howpub && !howpub.startsWith("http")) {
      f.venue = howpub.replace(/\\url\{[^}]+\}/g, "").trim();
    }
  }

  if (f.authorsRaw) {
    f.surnames = extractSurnames(f.authorsRaw);
  }
  return f;
}

export function extractFields(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (/^@[a-zA-Z]+\s*\{/m.test(text)) {
    return parseBibTeXFields(text);
  }

  const f = { raw: text };

  // DOI extraction (handles bare DOI, doi:, https://doi.org/)
  const doiM = text.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i);
  if (doiM) f.doi = stripTrailing(doiM[0]);

  // arXiv extraction (handles bare ID, arxiv:, arxiv.org/abs/)
  const arM =
    text.match(/arxiv\.org\/(?:abs|pdf)\/([^\s,"”]+)/i) ||
    text.match(/\barxiv:\s*([a-z\-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i) ||
    text.match(/\b(\d{4}\.\d{4,5}(?:v\d+)?)\b/) ||
    text.match(/\b([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})\b/i);

  if (arM) {
    const rawId = (arM[1] || arM[0]).replace(/^arxiv:\s*/i, "").replace(/v\d+$/i, "");
    f.arxivId = rawId;
  }

  // URL extraction
  const urlM = text.match(/https?:\/\/[^\s,"'>\)\]]+/i);
  if (urlM) {
    f.url = stripTrailing(urlM[0].replace(/[)\]]+$/, ""));
  }

  // ISBN extraction
  const isbnM =
    text.match(/\bISBN(?:-1[03])?[:\s]*([0-9Xx][0-9Xx\- –]{8,18}[0-9Xx])/i) ||
    text.match(/\b97[89](?:[- ]?\d){9}[- ]?[\dXx]\b/);
  if (isbnM) f.isbn = (isbnM[1] || isbnM[0]).replace(/[\s–]/g, "");

  // PubMed PMID
  const pmM = text.match(/\bpmid:?\s*(\d{5,9})\b/i);
  if (pmM) f.pmid = pmM[1];

  f.year = extractYear(text);

  const { authorsRaw, afterAuthors } = splitAuthors(text);
  if (authorsRaw) f.authorsRaw = authorsRaw;

  const sourceForTitle = authorsRaw ? afterAuthors : text;
  const qt = quotedTitle(sourceForTitle);
  if (qt) {
    f.title = qt;
  } else {
    // If text was only an arXiv ID or DOI or URL, don't set title to that identifier
    const isIdOnly = (f.arxivId && text.length <= f.arxivId.length + 8) || (f.url && text.length <= f.url.length + 8);
    if (!isIdOnly) {
      const restChunks = chunkSplit(sourceForTitle);
      let title = restChunks[0] || "";
      // Strip any URL that might have ended up in title chunk
      title = title.replace(/https?:\/\/\S+/gi, "").replace(/\s*\.\s*$/, "").trim();
      if (title.length >= 5) f.title = title;
    }
  }

  // Venue: the first post-title chunk that looks journal/proceedings-ish
  const titleEnd = f.title && sourceForTitle.includes(f.title)
    ? sourceForTitle.indexOf(f.title) + f.title.length
    : 0;
  const afterTitle = sourceForTitle.slice(titleEnd);
  for (const c of chunkSplit(afterTitle).slice(0, 3)) {
    if (
      (/\d/.test(c) &&
        /\b(?:vol|volume|issue|no|pp|pages|proc|conference|journal|transactions|proceedings|letters|review|annals|advances|blog|docs)\b/i.test(c)) ||
      /\d+\s*\(\d+\)/.test(c)
    ) {
      f.venue = c.replace(/\s*\.\s*$/, "").trim();
      break;
    }
  }

  const vi = text.match(/\b(\d{1,4})\s*\((\d{1,4})\)/);
  if (vi) {
    f.volume = vi[1];
    f.issue = vi[2];
  }

  if (f.isbn || (/\b(?:press|publishers?|publishing)\b/i.test(text) && !/journal|proceedings|transactions/i.test(text)))
    f.type = "book";
  else if (f.arxivId) f.type = "preprint";
  else if (/thesis|dissertation/i.test(text)) f.type = "thesis";
  else if (f.url && !f.doi && !f.arxivId && !/proceedings|transactions|journal/i.test(text)) f.type = "misc";
  else f.type = "article";

  f.surnames = extractSurnames(f.authorsRaw);
  return f;
}
