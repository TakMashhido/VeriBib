// String similarity and token analysis utilities for matching citations against bibliographic records.

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "up", "about", "into", "over", "after", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "via", "using", "based", "its", "their", "this", "that", "these", "those"
]);

export function normalize(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s = "", filterStopwords = false) {
  const words = normalize(s).split(" ").filter((w) => w.length > 1);
  if (!filterStopwords) return words;
  const filtered = words.filter((w) => !STOP_WORDS.has(w));
  return filtered.length ? filtered : words;
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
        aFlags[i] = true;
        bFlags[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aFlags[i]) continue;
    while (!bFlags[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
}

export function jaroWinkler(a, b) {
  const j = jaro(a, b);
  if (j < 0.7) return j;
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

// Symmetric Dice coefficient of content tokens.
// Returns 2 * |A ∩ B| / (|A| + |B|).
export function tokenDice(a = "", b = "", filterStopwords = true) {
  const tokA = tokens(a, filterStopwords);
  const tokB = tokens(b, filterStopwords);
  if (!tokA.length || !tokB.length) return 0;
  const setB = new Set(tokB);
  const common = tokA.filter((t) => setB.has(t)).length;
  return (2 * common) / (tokA.length + tokB.length);
}

// Fraction of needle's tokens that appear in haystack
export function tokenCover(haystack = "", needle = "", filterStopwords = false) {
  const H = new Set(tokens(haystack, filterStopwords));
  const N = tokens(needle, filterStopwords);
  if (!N.length) return 0;
  return N.filter((t) => H.has(t)).length / N.length;
}

// Robust semantic title similarity metric
export function semanticTitleSimilarity(entryTitle = "", recordTitle = "") {
  if (!entryTitle || !recordTitle) return 0;

  const normEntry = normalize(entryTitle);
  const normRec = normalize(recordTitle);
  if (normEntry === normRec) return 1.0;

  // Split subtitles if present (colon or dash)
  const mainEntry = entryTitle.split(/[:\-–—]/)[0].trim();
  const mainRec = recordTitle.split(/[:\-–—]/)[0].trim();

  const fullDice = tokenDice(entryTitle, recordTitle, true);
  const mainDice = tokenDice(mainEntry, mainRec, true);
  const bestDice = Math.max(fullDice, mainDice);

  const jaroFull = jaroWinkler(normEntry, normRec);
  const jaroMain = jaroWinkler(normalize(mainEntry), normalize(mainRec));
  const bestJaro = Math.max(jaroFull, jaroMain);

  // Length ratio penalty to prevent short generic candidate matching long fake title
  const lenRatio = Math.min(normEntry.length, normRec.length) / Math.max(normEntry.length, normRec.length);

  // Combined score: heavily weights tokenDice and length consistency
  let combined = 0;
  if (bestDice >= 0.8) {
    combined = 0.65 * bestDice + 0.35 * bestJaro;
  } else if (bestDice >= 0.5) {
    combined = 0.55 * bestDice + 0.35 * bestJaro + 0.1 * lenRatio;
  } else {
    // If fewer than half words match, clamp to prevent false positive Jaro prefix match
    combined = Math.min(bestDice, bestJaro) * Math.max(0.4, lenRatio);
  }

  return Math.min(1.0, Math.max(0, combined));
}

