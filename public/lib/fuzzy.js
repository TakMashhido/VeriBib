// String similarity helpers used to compare a citation against registry records.
// Pure functions, no I/O — runs unchanged in Node and the browser.

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "up", "about", "into", "over", "after", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "via", "using", "based", "its", "their", "this", "that", "these", "those",
]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s = "") {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}

// Strip HTML/MathML tags and entities that registries embed in titles.
export function cleanText(s = "") {
  return decodeEntities(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export function normalize(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s = "", filterStopwords = false) {
  const words = normalize(s).split(" ").filter((w) => w.length > 1 || /\d/.test(w));
  if (!filterStopwords) return words;
  const filtered = words.filter((w) => !STOP_WORDS.has(w));
  return filtered.length ? filtered : words;
}

// Comparable key for a surname: last token, accents removed ("van der Maaten" -> "maaten").
export function surnameKey(name = "") {
  const t = normalize(name).split(" ").filter(Boolean);
  return t.length ? t[t.length - 1] : "";
}

export function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aFlags = new Array(la).fill(false);
  const bFlags = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, lb);
    for (let j = lo; j < hi; j++) {
      if (!bFlags[j] && a[i] === b[j]) {
        aFlags[i] = bFlags[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aFlags[i]) continue;
    while (!bFlags[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  return (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
}

export function jaroWinkler(a, b) {
  const j = jaro(a, b);
  if (j < 0.7) return j;
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

// Symmetric Dice coefficient over (multi)sets of content tokens.
export function tokenDice(a = "", b = "", filterStopwords = true) {
  const A = tokens(a, filterStopwords);
  const B = tokens(b, filterStopwords);
  if (!A.length || !B.length) return 0;
  const pool = new Map();
  for (const t of B) pool.set(t, (pool.get(t) || 0) + 1);
  let common = 0;
  for (const t of A) {
    const n = pool.get(t);
    if (n) {
      common++;
      pool.set(t, n - 1);
    }
  }
  return (2 * common) / (A.length + B.length);
}

// Fraction of the needle's tokens that appear in the haystack.
export function tokenCover(haystack = "", needle = "", filterStopwords = false) {
  const H = new Set(tokens(haystack, filterStopwords));
  const N = tokens(needle, filterStopwords);
  if (!N.length) return 0;
  return N.filter((t) => H.has(t)).length / N.length;
}

const SUBTITLE_SPLIT = /\s*[:?!]\s+|\s+[-–—]\s+|\s*[–—]\s*/;

function mainTitle(s) {
  return String(s).split(SUBTITLE_SPLIT)[0].trim();
}

// Title similarity in [0, 1]. Symmetric, so a short real title cannot
// "match" a long fabricated one; tolerant of dropped subtitles and casing.
export function titleSimilarity(entryTitle = "", recordTitle = "") {
  if (!entryTitle || !recordTitle) return 0;
  const nE = normalize(entryTitle);
  const nR = normalize(recordTitle);
  if (!nE || !nR) return 0;
  if (nE === nR) return 1;

  const eHasSub = SUBTITLE_SPLIT.test(entryTitle);
  const rHasSub = SUBTITLE_SPLIT.test(recordTitle);
  const pairs = [[entryTitle, recordTitle]];
  if (eHasSub && rHasSub) pairs.push([mainTitle(entryTitle), mainTitle(recordTitle)]);
  else if (!eHasSub && rHasSub) pairs.push([entryTitle, mainTitle(recordTitle)]); // citation dropped the subtitle

  let score = 0;
  for (const [a, b] of pairs) {
    const na = normalize(a);
    const nb = normalize(b);
    const dice = tokenDice(a, b, true);
    const jw = jaroWinkler(na, nb);
    const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    let s = dice >= 0.8 ? 0.7 * dice + 0.3 * jw : dice * (0.75 + 0.25 * jw) * (0.85 + 0.15 * lenRatio);
    if (a !== entryTitle) s *= 0.97; // subtitle-only agreement is slightly weaker evidence
    score = Math.max(score, s);
  }
  const lenRatio = Math.min(nE.length, nR.length) / Math.max(nE.length, nR.length);

  // Citation drops the subtitle: every content word of the citation appears in the record.
  const entryTok = tokens(entryTitle, true);
  if (entryTok.length >= 3 && tokenCover(recordTitle, entryTitle, true) === 1 && lenRatio >= 0.4) {
    score = Math.max(score, 0.86);
  }
  return Math.min(1, Math.max(0, score));
}

// Kept for backwards compatibility with older imports.
export const semanticTitleSimilarity = titleSimilarity;
