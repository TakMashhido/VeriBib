// Bibliography parsing: split raw text into entries, detect the citation style,
// and extract structured fields. Handles APA, MLA, Chicago, Harvard, IEEE,
// Vancouver, BibTeX (balanced braces, LaTeX accents), RIS, and bare identifiers.
// Pure functions — shared by the Node server and the in-browser engine.

import { surnameKey } from "./fuzzy.js";

const MARKER_RE = /^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)])\s+/;
const BIB_START_RE = /(?<=^|[\s\]\)>])@\s*([a-zA-Z]+)\s*([{(])/g;
const RIS_RE = /^TY\s{1,2}-/m;
const LINK_TAIL_RE = /(?:doi\.org\/|doi:?\s*10\.|https?:\/\/)\S*$/i;
const YEAR = "(?:1[5-9]\\d{2}|20\\d{2})";

const NAME_START = "\\p{Lu}[\\p{L}'’\\-]+";
const AUTHOR_START_RES = [
  new RegExp(`^${NAME_START},\\s*\\p{Lu}`, "u"), // Surname, F.
  /^\p{Lu}\.(?:\s*\p{Lu}\.)*\s*\p{Lu}[\p{L}'’-]+/u, // F. Surname
  new RegExp(`^${NAME_START}\\s+\\p{Lu}{1,3}[.,\\s]`, "u"), // Surname FM, (Vancouver)
  new RegExp(`^${NAME_START},?\\s+(?:and|&)\\s+`, "iu"),
];

function looksLikeEntryStart(line) {
  return AUTHOR_START_RES.some((re) => re.test(line));
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export function cleanDoi(s) {
  const m = String(s || "").match(/10\.\d{4,9}\/[^\s"'<>{}]+/i);
  if (!m) return null;
  let doi = m[0];
  for (;;) {
    const before = doi;
    doi = doi.replace(/[.,;:]+$/, "");
    if (/\)$/.test(doi) && (doi.match(/\(/g) || []).length < (doi.match(/\)/g) || []).length) doi = doi.slice(0, -1);
    if (/\]$/.test(doi) && !doi.includes("[")) doi = doi.slice(0, -1);
    if (doi === before) break;
  }
  try {
    doi = decodeURIComponent(doi);
  } catch {
    /* keep as-is */
  }
  return doi;
}

function arxivFrom(text) {
  const m =
    text.match(/arxiv\.org\/(?:abs|pdf|html)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i) ||
    text.match(/10\.48550\/arxiv\.((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))/i) ||
    text.match(/\barxiv\s*[:\s]\s*((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i);
  if (m) return m[1].replace(/v\d+$/i, "").replace(/\.pdf$/i, "");
  // Bare new-style id (YYMM.NNNNN) — only outside of DOIs and URLs, with a valid month.
  const stripped = text.replace(/10\.\d{4,9}\/\S+/g, " ").replace(/https?:\/\/\S+/g, " ");
  const bare = stripped.match(/(?:^|[\s(\[,;])(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5})(?:v\d+)?(?=$|[\s).\],;])/);
  return bare ? bare[1] : null;
}

const ID_ONLY_RES = [
  /^(?:doi:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i,
  /^(?:arxiv:?\s*)?\d{4}\.\d{4,5}(?:v\d+)?$/i,
  /^arxiv:\s*\S+$/i,
  /^https?:\/\/\S+$/i,
  /^(?:isbn(?:-1[03])?:?\s*)[\dXx][\dXx\- ]{8,16}[\dXx]$/i,
  /^97[89][\d\- ]{10,14}$/,
  /^pmid:?\s*\d{5,9}$/i,
];

export function isIdentifierOnly(line) {
  const t = String(line || "").replace(MARKER_RE, "").trim().replace(/[.,;]$/, "");
  return ID_ONLY_RES.some((re) => re.test(t));
}

function hasIdentifier(text) {
  return /10\.\d{4,9}\/|https?:\/\/|arxiv[:.]|\bisbn\b|\bpmid\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

function matchClose(text, i, open, close) {
  let depth = 0;
  let inQuote = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (open === "(" && ch === '"' && depth >= 1) inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === open || (open === "(" && ch === "{")) depth++;
    else if (ch === close || (open === "(" && ch === "}")) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findBibtexBlocks(text) {
  const blocks = [];
  BIB_START_RE.lastIndex = 0;
  let m;
  while ((m = BIB_START_RE.exec(text))) {
    const type = m[1].toLowerCase();
    const openIdx = m.index + m[0].length - 1;
    const open = m[2];
    const close = open === "{" ? "}" : ")";
    let end = matchClose(text, openIdx, open, close);
    if (end === -1) {
      // Unterminated: run until the next entry or the end of input.
      BIB_START_RE.lastIndex = openIdx + 1;
      const next = BIB_START_RE.exec(text);
      end = next ? next.index - 1 : text.length - 1;
    }
    if (!["comment", "preamble", "string"].includes(type)) {
      blocks.push({ start: m.index, end: end + 1, text: text.slice(m.index, end + 1).trim() });
    }
    BIB_START_RE.lastIndex = end + 1;
  }
  return blocks;
}

function splitRIS(text) {
  const out = [];
  let cur = [];
  for (const line of text.split("\n")) {
    if (/^TY\s{1,2}-/.test(line) && cur.length) {
      out.push(cur.join("\n"));
      cur = [];
    }
    if (/^ER\s{1,2}-/.test(line)) {
      if (cur.length) out.push(cur.join("\n"));
      cur = [];
      continue;
    }
    if (line.trim()) cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out.map((b) => b.trim()).filter((b) => RIS_RE.test(b));
}

// ---------------------------------------------------------------------------
// Pasted-from-PDF clean-up
// ---------------------------------------------------------------------------

const LIGATURES = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
const SPACING_ACCENTS = { "¨": "\u0308", "ˆ": "\u0302", "˜": "\u0303", "¸": "\u0327", "ˇ": "\u030C", "˚": "\u030A", "˝": "\u030B", "˙": "\u0307", "˛": "\u0328", "´": "\u0301" };
const HEADING_RE = /^(?:\d+\.?\s*)?(?:references?(?:\s+list)?|bibliography|works\s+cited|literature\s+cited|cited\s+literature|sources|citations?)\s*:?$/i;
const PAGE_NO_RE = /^(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$|^[-–—]\s*\d{1,4}\s*[-–—]$/i;

// Character-level repairs for text copied out of a PDF: ligature glyphs, soft hyphens,
// zero-width characters, and accents that were extracted as separate spacing marks.
export function cleanPasted(text) {
  return String(text || "")
    .replace(/\u00AD[ \t]*\n[ \t]*/g, "") // soft hyphen at a line break: the word continues
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] || "")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/[\f\v]/g, "\n")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/([¨ˆ˜¸ˇ˚˝˙˛]|´(?=[aeiouyAEIOUYcCnNzZ]))\s?(\p{L})/gu, (_, a, ch) => ch + SPACING_ACCENTS[a])
    .normalize("NFC");
}

// Structural repairs: drop the "References" heading and stray page numbers, turn bare
// "12" lines that really are list numbers into markers, and re-join words that the
// PDF broke across a line ("recog-\nnition").
function tidyPlain(text) {
  const joined = text.replace(/(\p{Ll})-[ \t]*\n[ \t]*(?=\p{Ll})/gu, "$1");
  const lines = joined.split("\n").map((l) => l.trim());
  const out = [];
  let expected = 1;
  let pending = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (HEADING_RE.test(l)) continue;
    if (PAGE_NO_RE.test(l)) {
      // A bare number is a list marker only if it is the next one in sequence and text follows.
      const n = /^\d{1,3}$/.test(l) ? Number(l) : 0;
      const nextText = lines.slice(i + 1).find(Boolean) || "";
      if (n && n === expected && nextText && !PAGE_NO_RE.test(nextText)) {
        pending = `[${n}] `;
        expected++;
      }
      continue;
    }
    if (!l) {
      out.push("");
      continue;
    }
    out.push(pending + l);
    pending = "";
  }
  return out.join("\n").trim();
}

function splitPlain(text) {
  const clean = tidyPlain(text);
  if (!clean) return [];
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  // 1. Numbered markers: [1], 1., (1)
  if (lines.some((l) => MARKER_RE.test(l))) {
    const entries = [];
    let cur = [];
    const flush = () => {
      if (cur.length) entries.push(cur.join(" ").replace(/\s+/g, " ").trim());
      cur = [];
    };
    for (const line of lines) {
      if (MARKER_RE.test(line)) {
        flush();
        cur.push(line.replace(MARKER_RE, ""));
      } else cur.push(line);
    }
    flush();
    return entries.filter(Boolean);
  }

  // 2. Blank-line separated paragraphs
  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length >= 2) return paragraphs;

  // 3. One entry per line, merging wrapped continuation lines
  const entries = [];
  let cur = "";
  const yearRe = new RegExp(`\\b${YEAR}\\b`);
  for (const t of lines) {
    if (!cur) {
      cur = t;
      continue;
    }
    let startsNew;
    if (isIdentifierOnly(cur)) startsNew = true;
    else if (isIdentifierOnly(t)) startsNew = hasIdentifier(cur);
    else {
      // A trailing DOI/URL fragment may continue on the next line, unless that line starts a new reference.
      const openLink = LINK_TAIL_RE.test(cur);
      const curDone = (!openLink && /[.!?)"”\]\d/]$/.test(cur)) || (openLink && looksLikeEntryStart(t));
      startsNew = curDone && (looksLikeEntryStart(t) || (yearRe.test(cur) && yearRe.test(t) && /^[\p{Lu}"“]/u.test(t)));
    }
    if (startsNew) {
      entries.push(cur);
      cur = t;
    } else if (LINK_TAIL_RE.test(cur) && !/\s/.test(t)) {
      cur = `${cur}${t}`; // a link broken mid-token across two lines
    } else cur = `${cur} ${t}`;
  }
  if (cur) entries.push(cur);

  // 4. A single physical line holding several references
  if (entries.length === 1) {
    const one = entries[0];
    const multiComma = one.match(new RegExp(`${YEAR}[a-z]?\\)?[.;]?\\s+${NAME_START},\\s*\\p{Lu}`, "gu"))?.length || 0;
    const multiVanc = one.match(new RegExp(`${YEAR};\\s*\\d+[^;]*\\.\\s*${NAME_START}\\s+\\p{Lu}{1,3}[.,]`, "gu"))?.length || 0;
    if (multiComma >= 2 || multiVanc >= 2) {
      const parts = one
        .split(/(?<=[.;”"])\s+(?=\p{Lu}[\p{L}'’-]+(?:,\s*\p{Lu}|\s+\p{Lu}{1,3}[.,]))/u)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 1) return parts;
    }
  }
  return entries;
}

export function splitReferences(text) {
  const clean = cleanPasted(String(text || "").replace(/\r\n?/g, "\n")).trim();
  if (!clean) return [];

  if (RIS_RE.test(clean) && /^ER\s{1,2}-/m.test(clean)) {
    const ris = splitRIS(clean);
    if (ris.length) return ris;
  }

  const blocks = findBibtexBlocks(clean);
  if (!blocks.length) return splitPlain(clean);

  // Mixed input: BibTeX blocks interleaved with plain-text references.
  const out = [];
  let pos = 0;
  for (const b of blocks) {
    const between = clean.slice(pos, b.start).replace(/(?:^|\n)\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)])\s*$/, "");
    out.push(...splitPlain(between));
    out.push(b.text);
    pos = b.end;
  }
  out.push(...splitPlain(clean.slice(pos)));
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Style detection
// ---------------------------------------------------------------------------

const STYLES = ["apa", "mla", "chicago", "ieee", "harvard", "vancouver", "bibtex", "ris"];

export function detectStyle(text) {
  const t = String(text || "");
  const s = Object.fromEntries(STYLES.map((k) => [k, 0]));
  if (/^\s*@[a-zA-Z]+\s*[{(]/.test(t)) s.bibtex += 6;
  if (RIS_RE.test(t)) s.ris += 6;
  if (/^\s*\[\d{1,3}\]/.test(t)) s.ieee += 3;
  if (/^(?:\p{Lu}\.\s*)+\p{Lu}[\p{L}'’-]+/u.test(t.trim()) && /["“][^"”]{10,}[,.]?["”]/.test(t)) s.ieee += 3;
  if (/\((?:1[5-9]|20)\d{2}[a-z]?(?:,\s*[^)]+)?\)\./.test(t)) s.apa += 2.5;
  if (/["“][^"”]{15,300}\.["”]/.test(t)) s.mla += 2;
  if (/^\p{Lu}[\p{L}'’-]+ \p{Lu}{1,3}[.,]/u.test(t.trim())) s.vancouver += 2;
  if (/\b(?:19|20)\d{2}\s*(?:[A-Z][a-z]{2}\s*)?;\s*\d+\s*(?:\(|:)/.test(t)) s.vancouver += 2.5;
  if (/\b[A-Z][A-Za-z'’\-. ]{2,60}:\s*[A-Z][^,.;]{2,60},\s*(?:19|20)\d{2}/.test(t)) s.chicago += 2;
  if (/\((?:19|20)\d{2}[a-z]?\)\s*[‘'“]/.test(t)) s.harvard += 2.5;
  if (/\bvol\.\s*\d+/i.test(t)) {
    s.mla += 0.75;
    s.ieee += 0.75;
  }
  if (/\d+\s*\(\d+\)\s*,?\s*\d+\s*[–-]/.test(t)) s.apa += 1;
  if (/\bet al\.?/i.test(t)) s.apa += 0.25;
  if (/\bdoi:/i.test(t)) s.ieee += 0.5;
  if (/https?:\/\/doi\.org\//i.test(t)) s.apa += 0.5;
  if (/\bpp\.\s*\d+/i.test(t)) s.ieee += 0.5;
  return s;
}

function pickStyle(scores) {
  let style = "unknown";
  let best = 0.5;
  let total = 0;
  for (const [k, v] of Object.entries(scores)) {
    total += v;
    if (v > best) {
      style = k;
      best = v;
    }
  }
  const confidence = total ? Math.min(0.95, best / total) : 0;
  return { style, confidence: Math.round(confidence * 100) / 100 };
}

export function detectEntryStyle(text) {
  return pickStyle(detectStyle(text));
}

// Accepts raw text or an array of already-split entries.
export function detectBibliography(input) {
  const entries = Array.isArray(input) ? input : splitReferences(input);
  const agg = Object.fromEntries(STYLES.map((k) => [k, 0]));
  for (const e of entries) {
    const s = detectStyle(e);
    for (const k of STYLES) agg[k] += s[k];
  }
  const { style, confidence } = pickStyle(agg);
  return { count: entries.length, style, confidence };
}

// ---------------------------------------------------------------------------
// LaTeX / BibTeX
// ---------------------------------------------------------------------------

const ACCENTS = { "'": "́", "`": "̀", '"': "̈", "^": "̂", "~": "̃", "=": "̄", ".": "̇", u: "̆", v: "̌", H: "̋", c: "̧", k: "̨", r: "̊" };
const SPECIAL = { ss: "ß", o: "ø", O: "Ø", l: "ł", L: "Ł", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", i: "ı" };

export function cleanLatex(v = "") {
  return String(v)
    .replace(/\\url\s*\{([^}]*)\}/g, "$1")
    .replace(/\\href\s*\{[^}]*\}\s*\{([^}]*)\}/g, "$1")
    .replace(/\\([`'"^~=.])\s*\{?\\?([a-zA-Z])\}?/g, (_, a, ch) => ch + ACCENTS[a])
    .replace(/\\([uvHckr])(?:\s*\{\\?([a-zA-Z])\}|\s+([a-zA-Z]))/g, (_, a, c1, c2) => (c1 || c2) + ACCENTS[a])
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i)(?![a-zA-Z])\s*/g, (_, k) => SPECIAL[k])
    .replace(/\\([&%_$#{}])/g, "$1")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/~/g, " ")
    .replace(/\\[a-zA-Z]+\*?\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .normalize("NFC")
    .trim();
}

function readBibValue(text, i) {
  let value = "";
  for (;;) {
    while (/\s/.test(text[i] || "")) i++;
    const ch = text[i];
    if (ch === "{") {
      const end = matchClose(text, i, "{", "}");
      const stop = end === -1 ? text.length : end;
      value += text.slice(i + 1, stop);
      i = stop + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let depth = 0;
      for (; j < text.length; j++) {
        if (text[j] === "\\") {
          j++;
          continue;
        }
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        else if (text[j] === '"' && depth <= 0) break;
      }
      value += text.slice(i + 1, j);
      i = j + 1;
    } else {
      const m = text.slice(i).match(/^[^\s,#})]+/);
      if (!m) break;
      value += m[0];
      i += m[0].length;
    }
    while (/\s/.test(text[i] || "")) i++;
    if (text[i] === "#") {
      i++;
      continue;
    }
    break;
  }
  return { value, next: i };
}

export function parseBibtexFields(text) {
  const head = text.match(/^@\s*([a-zA-Z]+)\s*[{(]\s*([^,\s]*)\s*,?/);
  if (!head) return { type: null, key: null, fields: {} };
  const fields = {};
  let i = head[0].length;
  const nameRe = /[\s,]*([A-Za-z][\w\-:.]*)\s*=\s*/y;
  while (i < text.length) {
    nameRe.lastIndex = i;
    const m = nameRe.exec(text);
    if (!m) break;
    const { value, next } = readBibValue(text, nameRe.lastIndex);
    fields[m[1].toLowerCase()] = value;
    i = next;
  }
  return { type: head[1].toLowerCase(), key: head[2] || null, fields };
}

const PARTICLES = /^(?:van|von|de|der|den|del|della|da|di|du|dos|das|la|le|bin|al|el|ibn|ben|ter|ten|zu)$/i;

function splitTopLevelAnd(raw) {
  const out = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") depth--;
    else if (depth === 0 && /\s/.test(raw[i]) && /^\s+and\s+/i.test(raw.slice(i))) {
      out.push(raw.slice(last, i));
      const m = raw.slice(i).match(/^\s+and\s+/i);
      i += m[0].length - 1;
      last = i + 1;
    }
  }
  out.push(raw.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseNameList(raw, { bibtex = false } = {}) {
  const parts = bibtex ? splitTopLevelAnd(raw) : String(raw).split(/\s*;\s*/);
  const authors = [];
  for (const p of parts) {
    if (/^others$/i.test(p.trim())) continue;
    if (bibtex && /^\{[^{}]+\}$/.test(p.trim())) {
      authors.push({ given: "", family: cleanLatex(p) });
      continue;
    }
    const name = bibtex ? cleanLatex(p) : p.trim();
    if (!name) continue;
    if (name.includes(",")) {
      const seg = name.split(",").map((s) => s.trim());
      authors.push({ family: seg[0], given: seg[seg.length - 1] === seg[0] ? "" : seg.slice(1).filter((x) => !/^jr\.?$|^sr\.?$|^i{2,3}$/i.test(x)).join(" ") });
    } else {
      const words = name.split(/\s+/);
      let k = words.length - 1;
      while (k > 1 && PARTICLES.test(words[k - 1])) k--;
      authors.push({ given: words.slice(0, k).join(" "), family: words.slice(k).join(" ") });
    }
  }
  return authors;
}

function parseBibTeXEntry(text) {
  const { type, key, fields: F } = parseBibtexFields(text);
  const get = (...names) => {
    for (const n of names) if (F[n] != null && String(F[n]).trim()) return cleanLatex(F[n]);
    return null;
  };
  const f = { raw: text, format: "bibtex", citeKey: key };
  f.title = get("title");
  if (F.author) f.authors = parseNameList(F.author, { bibtex: true });
  else if (F.editor) f.authors = parseNameList(F.editor, { bibtex: true });
  f.authorsRaw = get("author", "editor");
  const y = (get("year") || get("date") || "").match(/\d{4}/);
  f.year = y ? parseInt(y[0], 10) : null;
  f.doi = cleanDoi(get("doi"));
  f.venue = get("journal", "journaltitle", "booktitle", "series") || null;
  f.volume = get("volume");
  f.issue = get("number", "issue");
  f.pages = get("pages");
  f.publisher = get("publisher", "institution", "organization", "school");
  f.isbn = get("isbn");
  f.pmid = get("pmid");

  const howpub = get("howpublished") || "";
  const note = get("note") || "";
  const url = get("url") || (howpub.match(/https?:\/\/\S+/) || note.match(/https?:\/\/\S+/) || [])[0];
  if (url) f.url = url.replace(/[.,;]+$/, "");

  const eprint = get("eprint");
  const archive = (get("archiveprefix", "eprinttype") || "").toLowerCase();
  if (eprint && (archive === "arxiv" || /^\d{4}\.\d{4,5}/.test(eprint) || /^arxiv:/i.test(eprint))) {
    f.arxivId = eprint.replace(/^arxiv:\s*/i, "").replace(/v\d+$/i, "");
  }
  if (!f.arxivId) f.arxivId = arxivFrom([f.url, f.doi, get("journal") || ""].filter(Boolean).join(" "));
  if (!f.doi && f.url) f.doi = /doi\.org\//i.test(f.url) ? cleanDoi(f.url) : null;

  const t = type || "misc";
  if (["misc", "online", "electronic", "www", "webpage", "software", "unpublished"].includes(t)) {
    f.type = f.arxivId ? "preprint" : "misc";
    if (!f.venue && howpub && !/^https?:/.test(howpub)) f.venue = howpub.replace(/https?:\/\/\S+/g, "").trim() || null;
  } else if (["book", "inbook", "incollection", "booklet"].includes(t)) f.type = "book";
  else if (["inproceedings", "conference", "proceedings"].includes(t)) f.type = "inproceedings";
  else if (["phdthesis", "mastersthesis", "thesis"].includes(t)) f.type = "thesis";
  else if (["techreport", "report"].includes(t)) f.type = "report";
  else f.type = "article";

  f.surnames = surnamesOf(f.authors);
  return f;
}

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------

const RIS_TYPES = { JOUR: "article", JFULL: "article", MGZN: "article", NEWS: "article", BOOK: "book", CHAP: "book", EBOOK: "book", CONF: "inproceedings", CPAPER: "inproceedings", THES: "thesis", RPRT: "report", ELEC: "misc", WEB: "misc", BLOG: "misc", GEN: "misc", UNPB: "preprint" };

function parseRISEntry(text) {
  const tags = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/);
    if (m) (tags[m[1]] ||= []).push(m[2].trim());
  }
  const one = (...k) => {
    for (const x of k) if (tags[x]?.[0]) return tags[x][0];
    return null;
  };
  const f = { raw: text, format: "ris" };
  f.type = RIS_TYPES[one("TY")] || "article";
  f.title = one("TI", "T1", "CT") || (f.type === "book" ? one("BT") : null);
  const au = [...(tags.AU || []), ...(tags.A1 || [])];
  f.authors = au.length ? parseNameList(au.join("; ")) : [];
  f.authorsRaw = au.join("; ") || null;
  const y = (one("PY", "Y1", "DA") || "").match(/\d{4}/);
  f.year = y ? parseInt(y[0], 10) : null;
  f.venue = one("T2", "JO", "JF", "JA", "BT") || null;
  f.volume = one("VL");
  f.issue = one("IS");
  const sp = one("SP");
  const ep = one("EP");
  f.pages = sp && ep ? `${sp}-${ep}` : sp;
  f.doi = cleanDoi(one("DO") || "");
  f.url = one("UR", "L1", "L2");
  f.publisher = one("PB");
  const sn = one("SN");
  if (sn && /^[\dXx-]{10,17}$/.test(sn.replace(/\s/g, "")) && sn.replace(/[^\dXx]/g, "").length >= 10) f.isbn = sn;
  f.arxivId = arxivFrom([f.url, f.doi].filter(Boolean).join(" "));
  if (f.arxivId && f.type === "misc") f.type = "preprint";
  f.surnames = surnamesOf(f.authors);
  return f;
}

// ---------------------------------------------------------------------------
// Plain-text citations
// ---------------------------------------------------------------------------

function surnamesOf(authors = []) {
  return [...new Set(authors.map((a) => surnameKey(a.family)).filter(Boolean))];
}

const NOT_NAMES = new Set(["et", "al", "and", "in", "eds", "ed", "jr", "sr", "the", "of", "for", "with"]);

export function extractSurnames(authorsRaw) {
  if (!authorsRaw) return [];
  const text = String(authorsRaw).replace(/\bet\s+al\.?/gi, " ").replace(/&/g, " and ").trim();
  const hits = [];
  const add = (re, group = 1) => {
    for (const m of text.matchAll(re)) hits.push({ i: m.index + m[0].indexOf(m[group]), s: m[group] });
  };
  add(/(\p{Lu}[\p{L}'’-]+)\s*,\s*(?:\p{Lu}\p{Ll}+|\p{Lu}(?:\.|(?![\p{L}])))/gu); // Surname, F. / Surname, Given
  add(/(?:\p{Lu}\.\s*(?:-\s*)?)+(\p{Lu}[\p{L}'’-]+)(?![\p{L}.])/gu); // F. M. Surname
  add(/(?:^|,\s*|\band\s+)(\p{Lu}[\p{L}'’-]+)\s+\p{Lu}{1,3}(?=[,.;]|\s*$)/gu); // Surname FM (Vancouver)
  add(/\band\s+\p{Lu}\p{Ll}+(?:\s+\p{Lu}\.?)?\s+(\p{Lu}[\p{L}'’-]+)/gu); // and Given Surname (Chicago/MLA)
  hits.sort((a, b) => a.i - b.i);
  let out = [...new Set(hits.map((h) => surnameKey(h.s)).filter((s) => s.length > 1 && !NOT_NAMES.has(s)))];

  if (!out.length) {
    for (const p of text.split(/\s+and\s+|[,;]/i)) {
      const words = p
        .replace(/[^\p{L}\p{M}'’\- ]/gu, "")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !PARTICLES.test(w));
      if (words.length) {
        const s = surnameKey(words[words.length - 1]);
        if (s && !NOT_NAMES.has(s) && !out.includes(s)) out.push(s);
      }
    }
  }
  return out;
}

function quotedTitle(text) {
  const m =
    text.match(/[“"]([^“”"]{8,300}?)[”"]/) ||
    text.match(/(?:^|\s)‘([^‘’]{8,300})’/) ||
    text.match(/(?:^|\s)'([^']{8,300})'(?=[\s,.;:]|$)/);
  return m ? m[1].replace(/\s+/g, " ").replace(/[\s,.;:]+$/, "").trim() : null;
}

// Split at sentence boundaries, skipping initials and common abbreviations.
function chunkSplit(text) {
  const chunks = [];
  let start = 0;
  const re = /[.!?]\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(start, m.index);
    const lastWord = (before.match(/([^\s.]+)$/) || [])[1] || "";
    if (/^\p{Lu}$/u.test(lastWord)) continue;
    if (/^(?:al|eg|e\.g|ie|i\.e|cf|vs|ca|no|nos|pp|p|ed|eds|vol|vols|jr|sr|st|mr|ms|mrs|dr|prof|inc|ltd|co|fig|eq|proc|conf|int|trans|j|univ|dept)$/i.test(lastWord)) continue;
    chunks.push(text.slice(start, m.index + 1).trim());
    start = m.index + m[0].length;
  }
  if (start < text.length) chunks.push(text.slice(start).trim());
  return chunks.filter(Boolean);
}

function stripIdentifiers(text, arxivId) {
  const out = stripIdentifierPatterns(text);
  return (arxivId ? out.split(arxivId).join(" ") : out)
    .replace(/\b(?:arxiv(?:\s+preprint)?|doi|pmid|isbn|url|available|online)\s*[:.]?(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripIdentifierPatterns(text) {
  return text
    .replace(/\[online\]\.?\s*available:?/gi, " ")
    .replace(/\b(?:retrieved|accessed)\b[^.]*?(?=https?:\/\/|$)/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bdoi:?\s*10\.\d{4,9}\/\S+/gi, " ")
    .replace(/10\.\d{4,9}\/\S+/g, " ")
    .replace(/\barxiv(?:\s+preprint)?\s*:?\s*(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?/gi, " ")
    .replace(/\b(?:isbn|pmid|pmcid|issn)(?:-1[03])?:?\s*[\dXx-]+/gi, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYear(text) {
  const paren = text.match(new RegExp(`\\((${YEAR})[a-z]?(?:[,\\s][^)]*)?\\)`));
  if (paren) return parseInt(paren[1], 10);
  const vanc = text.match(new RegExp(`\\b(${YEAR})(?:\\s+[A-Z][a-z]{2})?\\s*;`));
  if (vanc) return parseInt(vanc[1], 10);
  const end = text.match(new RegExp(`\\b(${YEAR})[a-z]?[.\\s]*$`));
  if (end) return parseInt(end[1], 10);
  for (const m of text.matchAll(new RegExp(`\\b(${YEAR})\\b`, "g"))) {
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    const after = text.slice(m.index + 4, m.index + 6);
    if (/[:\-–]\s*$/.test(before) || /^\s*[-–]\s*\d/.test(after)) continue; // page range
    return parseInt(m[1], 10);
  }
  return null;
}

function splitAuthors(text) {
  const parenM = text.match(/^([\s\S]{3,400}?)\s*\((?:\d{4}|n\.d\.)[a-z]?[^)]*\)[.,:]?\s*/);
  if (parenM && !/["“]/.test(parenM[1])) {
    return { authorsRaw: parenM[1].replace(/[\s,.]+$/, ""), rest: text.slice(parenM[0].length), mode: "year-paren" };
  }
  const qM = text.match(/^([^"“]{0,400}?)\s*["“]/);
  if (qM && qM[1] && /[,.]/.test(qM[1]) && qM[1].length < 400) {
    return { authorsRaw: qM[1].replace(/[\s,.:]+$/, ""), rest: text.slice(qM[1].length), mode: "quoted" };
  }
  const harvard = text.match(/^([^‘']{3,300}?)\s*\(\d{4}[a-z]?\)\s*(?=[‘'])/);
  if (harvard) return { authorsRaw: harvard[1].replace(/[\s,.]+$/, ""), rest: text.slice(harvard[0].length), mode: "harvard" };

  const vanc = text.match(/^((?:\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?\s+\p{Lu}{1,3},\s*)*\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?\s+\p{Lu}{1,3}(?:,?\s*et al)?)\.\s+/u);
  if (vanc) return { authorsRaw: vanc[1], rest: text.slice(vanc[0].length), mode: "vancouver" };

  const chunks = chunkSplit(text);
  const first = chunks[0] || "";
  const looksLikeAuthors =
    first.length > 2 &&
    first.length < 300 &&
    (/,\s/.test(first) || /\b\p{Lu}\.\s/u.test(first) || /^\p{Lu}[\p{L}'’-]+ \p{Lu}{1,3}[.,]/u.test(first)) &&
    !new RegExp(`\\b${YEAR}\\b`).test(first.slice(0, 40)) &&
    (looksLikeEntryStart(first) || /\bet al\b/.test(first));
  if (looksLikeAuthors && chunks.length > 1) {
    return { authorsRaw: first.replace(/\.$/, ""), rest: chunks.slice(1).join(" "), mode: "chunk" };
  }
  return { authorsRaw: null, rest: text, mode: "none" };
}

function cleanVenue(s) {
  const v = String(s || "")
    .replace(/^(?:in:?|in proceedings of(?: the)?)\s+/i, "")
    .replace(/[,.]?\s*(?:vol\.|volume|no\.|pp\.|pages?)\s*[\d\-–]+.*$/i, "")
    .replace(/,?\s*(?:pp?\.\s*)?\d+\s*[-–]+\s*\d+\.?$/, "")
    .replace(/,?\s*\d+\s*(?:\(\d+\))?\s*(?:[,:]\s*[\d\-–e]+)?\.?$/i, "")
    .replace(new RegExp(`,?\\s*${YEAR}\\.?$`), "")
    .replace(/\s*\((?:pp?\.?|pages?)?\s*$/i, "")
    .replace(/^[\s,.;:]+|[\s,.;:]+$/g, "")
    .trim();
  return v.length >= 3 && v.length <= 200 && /\p{L}{3}/u.test(v) ? v : null;
}

export function extractFields(raw) {
  const original = String(raw || "").trim();
  if (/^@\s*[a-zA-Z]+\s*[{(]/.test(original)) return parseBibTeXEntry(original);
  if (RIS_RE.test(original)) return parseRISEntry(original);

  const text = original.replace(/\s+/g, " ").replace(MARKER_RE, "").trim();
  const f = { raw: text, format: "text" };

  const doiSrc = text.match(/(?:doi\.org\/|doi:?\s*)(10\.\d{4,9}\/[^\s"'<>]+)/i)?.[1] || text;
  f.doi = cleanDoi(doiSrc);
  f.arxivId = arxivFrom(text);
  const urls = [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map((m) => m[0].replace(/[.,;)\]]+$/, ""));
  f.url = urls.find((u) => !/doi\.org\//i.test(u)) || urls[0] || null;

  const isbnM = text.match(/\bISBN(?:-1[03])?:?\s*([\dXx][\dXx\- ]{8,16}[\dXx])/i) || text.match(/\b97[89](?:[- ]?\d){9}[- ]?[\dXx]\b/);
  if (isbnM) {
    const isbn = (isbnM[1] || isbnM[0]).replace(/[^\dXx]/g, "");
    if (isbn.length === 10 || isbn.length === 13) f.isbn = isbn;
  }
  const pm = text.match(/\bpmid:?\s*(\d{5,9})\b/i);
  if (pm) f.pmid = pm[1];

  const body = stripIdentifiers(text, f.arxivId);
  f.year = extractYear(body);
  // "Epub 2018" / "published online 2018": other years the same work legitimately carries.
  const altRe = new RegExp(`(?:e-?pub|published|online|accepted|ahead of print)\\b[^.;()\\d]{0,25}?(?:\\d{1,2}\\s+[A-Z][a-z]{2,8}\\s+|[A-Z][a-z]{2,8}\\s+\\d{0,2},?\\s*)?\\b(${YEAR})\\b`, "gi");
  const altYears = [...new Set([...text.matchAll(altRe)].map((m) => parseInt(m[1], 10)))].filter((y) => y !== f.year);
  if (altYears.length) f.altYears = altYears;

  if (body.length >= 5) {
    const { authorsRaw, rest, mode } = splitAuthors(body);
    if (authorsRaw) f.authorsRaw = authorsRaw;
    const qt = quotedTitle(rest);
    let after = "";
    if (qt) {
      f.title = qt;
      after = rest.slice(rest.indexOf(qt) + qt.length).replace(/^[\s,.;:"”’']+/, "");
    } else {
      const chunks = chunkSplit(rest);
      let title = (chunks[0] || "").replace(/^[*_]+|[*_]+$/g, "").replace(/[\s.]+$/, "").trim();
      if (mode === "none" && chunks.length === 1 && new RegExp(`^${YEAR}$`).test(title)) title = "";
      if (title.length >= 5 && /\p{L}{2}/u.test(title)) f.title = title;
      after = chunks.slice(1).join(" ");
    }
    if (f.title) f.title = f.title.replace(/^[*_]+|[*_]+$/g, "").trim();
    const venueSrc = mode === "quoted" || qt ? after.split(/,\s*(?:vol\.|no\.|pp\.|\d{4}\b)|\.\s/)[0] : chunkSplit(after)[0];
    f.venue = cleanVenue(venueSrc);
  }

  const vi = body.match(/\b(\d{1,4})\s*\((\d{1,4}(?:[-–]\d{1,4})?)\)/);
  if (vi) {
    f.volume = vi[1];
    f.issue = vi[2];
  } else {
    const vol = body.match(/\bvol\.?\s*(\d{1,4})/i);
    if (vol) f.volume = vol[1];
  }
  const pages = body.match(/\b(?:pp?\.\s*)?(\d{1,6}\s*[-–]{1,2}\s*\d{1,6})\b/);
  if (pages && !new RegExp(`^${YEAR}\\s*[-–]`).test(pages[1])) f.pages = pages[1].replace(/\s+/g, "").replace(/--/, "–");

  if (f.isbn || (/\b(?:press|publishers?|publishing|verlag|edition|ed\.)\b/i.test(text) && !/journal|proceedings|transactions|conference/i.test(text))) f.type = "book";
  else if (f.arxivId || /\barxiv\b|preprint/i.test(text)) f.type = "preprint";
  else if (/\b(?:thesis|dissertation)\b/i.test(text)) f.type = "thesis";
  else if (f.url && !f.doi && !/proceedings|transactions|journal|conference/i.test(text)) f.type = "misc";
  else if (/proceedings|conference|symposium|workshop|\bconf\b/i.test(text)) f.type = "inproceedings";
  else f.type = "article";

  f.surnames = extractSurnames(f.authorsRaw);
  return f;
}
