// Citation formatters (APA 7, IEEE, MLA 9, BibTeX) for a normalized registry record:
// { title, authors: [{given, family}], year, container, volume, issue, pages,
//   publisher, doi, url, type, arxivId, siteName }

export function initials(given = "") {
  return String(given)
    .replace(/\./g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.split("-").map((p) => (p ? `${p[0].toUpperCase()}.` : "")).join("-"))
    .join(" ");
}

const tidy = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\s.,;:]+$/, "").trim();
const sentenceEnd = (s) => (/[.?!]$/.test(s) ? s : `${s}.`);
const pagesDash = (p) => String(p || "").replace(/\s*-{1,2}\s*/g, "–");
const doiUrl = (r) => (r.doi ? `https://doi.org/${r.doi}` : r.url || "");

function isPreprint(r) {
  return r.type === "preprint" || /^10\.48550\//i.test(r.doi || "") || r.source === "arXiv";
}
function isWeb(r) {
  return r.type === "web" || (r.type === "misc" && /^Web/.test(r.source || ""));
}

// ---------------------------------------------------------------------------
// APA 7
// ---------------------------------------------------------------------------

function apaName(a) {
  if (!a.given) return a.family || "";
  return `${a.family}, ${initials(a.given)}`;
}

function apaAuthors(list) {
  const a = (list || []).filter((x) => x.family || x.given);
  if (!a.length) return "";
  const names = a.map(apaName);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, & ${names[1]}`;
  if (names.length <= 20) return `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
  return `${names.slice(0, 19).join(", ")}, . . . ${names.at(-1)}`;
}

export function formatAPA(r) {
  if (!r) return "";
  const authors = apaAuthors(r.authors);
  const year = `(${r.year || "n.d."}).`;
  const title = r.title ? sentenceEnd(tidy(r.title)) : "";
  let source = "";
  if (r.type === "book") source = r.publisher ? sentenceEnd(tidy(r.publisher)) : "";
  else if (isPreprint(r)) source = sentenceEnd(tidy(r.container && !/arxiv/i.test(r.container) ? r.container : "arXiv"));
  else if (isWeb(r)) source = r.siteName || r.container ? sentenceEnd(tidy(r.siteName || r.container)) : "";
  else if (r.container) {
    let s = tidy(r.container);
    if (r.volume) s += `, ${r.volume}`;
    if (r.issue) s += r.volume ? `(${r.issue})` : `, (${r.issue})`;
    if (r.pages) s += `, ${pagesDash(r.pages)}`;
    source = `${s}.`;
  }
  const head = authors ? `${sentenceEnd(authors)} ${year}` : `${title} ${year}`;
  const parts = authors ? [head, title, source, doiUrl(r)] : [head, source, doiUrl(r)];
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// IEEE
// ---------------------------------------------------------------------------

function ieeeName(a) {
  return [initials(a.given), a.family].filter(Boolean).join(" ");
}

function ieeeAuthors(list) {
  const a = (list || []).filter((x) => x.family || x.given).map(ieeeName);
  if (!a.length) return "";
  if (a.length > 6) return `${a[0]} et al.`;
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, and ${a.at(-1)}`;
}

export function formatIEEE(r) {
  if (!r) return "";
  const authors = ieeeAuthors(r.authors);
  const title = r.title ? `“${tidy(r.title)},”` : "";
  const bits = [];
  if (r.type === "book") {
    if (r.publisher) bits.push(tidy(r.publisher));
  } else if (isPreprint(r)) {
    bits.push(r.arxivId ? `arXiv:${r.arxivId}` : tidy(r.container || "arXiv preprint"));
  } else if (r.container || r.siteName) {
    bits.push(tidy(r.type === "inproceedings" && !/^in /i.test(r.container || "") ? `in ${r.container}` : r.container || r.siteName));
  }
  if (r.volume) bits.push(`vol. ${r.volume}`);
  if (r.issue) bits.push(`no. ${r.issue}`);
  if (r.pages) bits.push(`${/[-–]/.test(r.pages) ? "pp." : "p."} ${pagesDash(r.pages)}`);
  if (r.year) bits.push(String(r.year));
  let out = [authors ? `${authors},` : "", title, bits.join(", ")].filter(Boolean).join(" ");
  if (r.doi) out += `, doi: ${r.doi}.`;
  else if (r.url) out += `. [Online]. Available: ${r.url}`;
  else out += ".";
  return out.replace(/,\s*\./g, ".").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// MLA 9
// ---------------------------------------------------------------------------

function mlaAuthors(list) {
  const a = (list || []).filter((x) => x.family || x.given);
  if (!a.length) return "";
  const inv = (x) => (x.given ? `${x.family}, ${x.given}` : x.family);
  const fwd = (x) => [x.given, x.family].filter(Boolean).join(" ");
  if (a.length === 1) return inv(a[0]);
  if (a.length === 2) return `${inv(a[0])}, and ${fwd(a[1])}`;
  return `${inv(a[0])}, et al`;
}

export function formatMLA(r) {
  if (!r) return "";
  const authors = mlaAuthors(r.authors);
  const title = r.title ? `“${sentenceEnd(tidy(r.title))}”` : "";
  const bits = [];
  if (r.type === "book") {
    if (r.publisher) bits.push(tidy(r.publisher));
  } else {
    const c = isPreprint(r) && !r.container ? "arXiv" : r.container || r.siteName;
    if (c) bits.push(tidy(c));
    if (r.volume) bits.push(`vol. ${r.volume}`);
    if (r.issue) bits.push(`no. ${r.issue}`);
  }
  if (r.year) bits.push(String(r.year));
  if (r.pages && r.type !== "book") bits.push(`${/[-–]/.test(r.pages) ? "pp." : "p."} ${pagesDash(r.pages)}`);
  const link = r.doi ? `https://doi.org/${r.doi}` : r.url ? r.url.replace(/^https?:\/\//, "") : "";
  return [authors ? sentenceEnd(authors) : "", title, bits.length ? `${bits.join(", ")}.` : "", link ? `${link}.` : ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

function texEscape(s) {
  return String(s || "").replace(/([&%#_$])/g, "\\$1");
}

function asciiWord(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function bibtexKey(r) {
  const fam = asciiWord(r.authors?.[0]?.family) || "anon";
  const word =
    String(r.title || "")
      .split(/\s+/)
      .map(asciiWord)
      .find((w) => w.length >= 4 && !["with", "from", "that", "this", "towards", "toward", "into", "using", "over"].includes(w)) || "work";
  return `${fam}${r.year || ""}${word}`;
}

export function formatBibTeX(r) {
  if (!r) return "";
  let type = "article";
  if (r.type === "book") type = "book";
  else if (r.type === "chapter") type = "incollection";
  else if (r.type === "inproceedings" || /proceedings|conference|symposium|workshop/i.test(r.container || "")) type = "inproceedings";
  else if (r.type === "thesis") type = "phdthesis";
  else if (r.type === "report") type = "techreport";
  else if (isPreprint(r) || isWeb(r) || !r.container) type = "misc";

  const authors = (r.authors || [])
    .filter((a) => a.family)
    .map((a) => (a.given ? `${a.family}, ${a.given}` : `{${a.family}}`))
    .join(" and ");

  const fields = [];
  const add = (k, v, raw = false) => {
    if (v != null && String(v).trim()) fields.push(`  ${k.padEnd(12)} = {${raw ? v : texEscape(v)}}`);
  };
  if (r.title) add("title", `{${texEscape(tidy(r.title))}}`, true);
  add("author", authors);
  add("year", r.year);
  if (type === "article") add("journal", r.container);
  else if (type === "inproceedings" || type === "incollection") add("booktitle", r.container);
  else if (type === "misc" && !isPreprint(r) && (r.siteName || r.container)) add("howpublished", r.siteName || r.container);
  add("volume", r.volume);
  add("number", r.issue);
  add("pages", r.pages ? String(r.pages).replace(/\s*[-–]+\s*/g, "--") : "");
  if (type === "book" || type === "incollection" || type === "techreport") add(type === "techreport" ? "institution" : "publisher", r.publisher);
  if (isPreprint(r) && r.arxivId) {
    add("eprint", r.arxivId, true);
    add("archiveprefix", "arXiv", true);
  }
  add("doi", r.doi, true);
  if (r.url && !r.doi) add("url", r.url, true);
  return `@${type}{${bibtexKey(r)},\n${fields.join(",\n")}\n}`;
}

export function formatAll(r) {
  if (!r) return null;
  return { apa: formatAPA(r), ieee: formatIEEE(r), mla: formatMLA(r), bibtex: formatBibTeX(r) };
}
