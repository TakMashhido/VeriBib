// Verification engine: query providers, score candidate records, determine verdict, format corrections.

import * as p from "./providers.js";
import { normalize, semanticTitleSimilarity, tokenDice } from "./fuzzy.js";

const CURRENT_YEAR = 2026;

// Format clean APA citation
export function formatAPA(r) {
  if (!r) return "";
  const auths = r.authors || [];
  let authorStr = "Unknown author";
  if (auths.length === 1) {
    const a = auths[0];
    authorStr = `${a.family || ""}, ${a.given ? a.given[0] + "." : ""}`.trim();
  } else if (auths.length >= 2 && auths.length <= 7) {
    authorStr = auths
      .map((a) => `${a.family || ""}, ${a.given ? a.given[0] + "." : ""}`.trim())
      .join(", ");
    const lastComma = authorStr.lastIndexOf(",");
    if (lastComma !== -1) {
      authorStr = authorStr.slice(0, lastComma) + ", &" + authorStr.slice(lastComma + 1);
    }
  } else if (auths.length > 7) {
    const firstSix = auths.slice(0, 6).map((a) => `${a.family || ""}, ${a.given ? a.given[0] + "." : ""}`.trim()).join(", ");
    const last = auths[auths.length - 1];
    authorStr = `${firstSix}, ... ${last.family || ""}, ${last.given ? last.given[0] + "." : ""}`.trim();
  }

  const yr = r.year ? `(${r.year})` : "(n.d.)";
  const title = r.title ? `${r.title.replace(/[.,\s]+$/, "")}.` : "";
  const isWeb = r.type === "misc" || r.source?.startsWith("Web");
  const container = r.container ? `*${r.container}*` : isWeb && r.siteName ? `*${r.siteName}*` : "";
  const vol = r.volume ? `**${r.volume}**` : "";
  const iss = r.issue ? `(${r.issue})` : "";
  const volIss = vol && iss ? `${vol}${iss}` : vol || iss;
  const pages = r.pages ? `, ${r.pages}` : "";
  const loc = volIss ? `, ${volIss}${pages}` : pages;
  const link = r.doi ? ` https://doi.org/${r.doi}` : r.url ? ` ${r.url}` : "";

  return [authorStr, yr, title, container ? `${container}${loc}.` : "", link].filter(Boolean).join(" ");
}

// Format clean IEEE citation
export function formatIEEE(r) {
  if (!r) return "";
  const auths = r.authors || [];
  let authorStr = "Unknown author";
  if (auths.length === 1) {
    const a = auths[0];
    authorStr = `${a.given ? a.given[0] + ". " : ""}${a.family || ""}`.trim();
  } else if (auths.length === 2) {
    const a1 = `${auths[0].given ? auths[0].given[0] + ". " : ""}${auths[0].family || ""}`.trim();
    const a2 = `${auths[1].given ? auths[1].given[0] + ". " : ""}${auths[1].family || ""}`.trim();
    authorStr = `${a1} and ${a2}`;
  } else if (auths.length >= 3 && auths.length <= 6) {
    const list = auths.map((a) => `${a.given ? a.given[0] + ". " : ""}${a.family || ""}`.trim());
    authorStr = `${list.slice(0, -1).join(", ")}, and ${list.at(-1)}`;
  } else if (auths.length > 6) {
    const a = auths[0];
    authorStr = `${a.given ? a.given[0] + ". " : ""}${a.family || ""}`.trim() + " et al.";
  }

  const title = r.title ? `"${r.title.replace(/[.,\s]+$/, "")},"` : "";
  const container = r.container ? `*${r.container}*` : "";
  const vol = r.volume ? `vol. ${r.volume}` : "";
  const iss = r.issue ? `no. ${r.issue}` : "";
  const volIss = [vol, iss].filter(Boolean).join(", ");
  const pages = r.pages ? `pp. ${r.pages}` : "";
  const yr = r.year ? `${r.year}` : "";
  const details = [container, volIss, pages, yr].filter(Boolean).join(", ");
  const link = r.doi ? ` doi: ${r.doi}.` : r.url ? ` [Online]. Available: ${r.url}.` : ".";

  return [authorStr, title, details].filter(Boolean).join(", ") + link;
}

// Format clean BibTeX record
export function formatBibTeX(r) {
  if (!r) return "";
  const firstAuthor = r.authors?.[0]?.family?.toLowerCase().replace(/[^a-z]/g, "") || "anon";
  const firstWord = (r.title || "work").toLowerCase().split(/\s+/).find((w) => w.length >= 3)?.replace(/[^a-z]/g, "") || "paper";
  const key = `${firstAuthor}${r.year || "unknown"}${firstWord}`;

  const authorStr = (r.authors || [])
    .map((a) => `${a.family || ""}, ${a.given || ""}`.trim())
    .filter(Boolean)
    .join(" and ");

  let type = "article";
  if (r.type === "book") type = "book";
  else if (r.type === "preprint" || (!r.container && r.source === "arXiv")) type = "misc";
  else if (r.type === "misc" || r.source?.startsWith("Web")) type = "misc";
  else if (r.container && /proc|conference|symposium/i.test(r.container)) type = "inproceedings";

  const lines = [`@${type}{${key},`];
  if (r.title) lines.push(`  title = {${r.title}},`);
  if (authorStr) lines.push(`  author = {${authorStr}},`);
  if (r.year) lines.push(`  year = {${r.year}},`);
  if (type === "article" && r.container) lines.push(`  journal = {${r.container}},`);
  else if (type === "inproceedings" && r.container) lines.push(`  booktitle = {${r.container}},`);
  else if (type === "misc" && r.url) lines.push(`  howpublished = {\\url{${r.url}}},`);
  else if (r.container) lines.push(`  howpublished = {${r.container}},`);
  if (r.volume) lines.push(`  volume = {${r.volume}},`);
  if (r.issue) lines.push(`  number = {${r.issue}},`);
  if (r.pages) lines.push(`  pages = {${r.pages}},`);
  if (r.doi) lines.push(`  doi = {${r.doi}},`);
  if (r.url && type !== "misc") lines.push(`  url = {${r.url}},`);
  if (r.publisher) lines.push(`  publisher = {${r.publisher}},`);

  // Remove trailing comma from last field
  const lastIdx = lines.length - 1;
  if (lines[lastIdx].endsWith(",")) {
    lines[lastIdx] = lines[lastIdx].slice(0, -1);
  }
  lines.push("}");
  return lines.join("\n");
}

export function formatCorrectedCitation(r) {
  return formatAPA(r);
}

export function computeMatchScore(entry, rec, hasDoi = false, doiResolved = false) {
  if (!rec || !rec.title) return { score: 0, reasons: {}, flags: ["No candidate record"] };

  const reasons = {};
  const flags = [];
  let score = 0;

  // 1. Semantic Title Matching (up to 50 pts)
  const entryTitleOrRaw = entry.title || entry.raw;
  const titleSim = semanticTitleSimilarity(entryTitleOrRaw, rec.title);
  const titlePts = Math.round(titleSim * 50);
  score += titlePts;
  reasons.title = `Title similarity: ${Math.round(titleSim * 100)}% (${titlePts}/50 pts)`;

  if (titleSim < 0.35 && entry.title) {
    flags.push(`Title mismatch: candidate title ("${rec.title.slice(0, 50)}...") differs significantly from citation`);
  }

  // 2. Author Overlap & First Author Check (up to 30 pts)
  const eSurnames = entry.surnames || [];
  const rSurnames = rec.surnames || [];

  if (eSurnames.length > 0 && rSurnames.length > 0) {
    const firstAuthorMatch = eSurnames[0] === rSurnames[0] || rSurnames.includes(eSurnames[0]);
    const overlap = eSurnames.filter((s) => rSurnames.includes(s)).length;
    const authorRatio = overlap / eSurnames.length;

    let authorPts = Math.round(authorRatio * 20);
    if (firstAuthorMatch) authorPts += 10;
    score += authorPts;

    reasons.authors = `Author match: ${overlap}/${eSurnames.length} matched (${authorPts}/30 pts)`;
    if (overlap === 0) {
      flags.push(`Author mismatch: none of the citation authors (${eSurnames.join(", ")}) match the record authors (${rSurnames.slice(0, 3).join(", ")})`);
      score -= 15; // Severe penalty for complete author mismatch
    }
  } else if (eSurnames.length > 0 && rSurnames.length === 0) {
    // Citation specifies authors, but record candidate has no authors
    score += 5;
    reasons.authors = `Author check: Record has no author metadata (5/30 pts)`;
    flags.push(`Author unconfirmed: Record candidate has no author data to verify "${eSurnames.join(", ")}"`);
  } else {
    // Neither entry nor record has authors (e.g. arXiv identifier lookup)
    score += 15;
    reasons.authors = `Author check: Neutral (15/30 pts, no authors extracted in entry)`;
  }

  // 3. Publication Year Proximity (up to 20 pts)
  if (entry.year && rec.year) {
    const diff = Math.abs(entry.year - rec.year);
    if (diff === 0) {
      score += 20;
      reasons.year = `Year: Exact match (${entry.year})`;
    } else if (diff === 1) {
      score += 16;
      reasons.year = `Year: 1 year difference (entry: ${entry.year}, record: ${rec.year})`;
    } else if (diff <= 3) {
      score += 8;
      reasons.year = `Year: ${diff} years difference (entry: ${entry.year}, record: ${rec.year})`;
    } else {
      reasons.year = `Year mismatch: ${diff} years difference (entry: ${entry.year}, record: ${rec.year})`;
      flags.push(`Year discrepancy: citation says ${entry.year}, but record published in ${rec.year}`);
      score -= Math.min(15, diff * 2); // Heavy penalty for large year gaps
    }

    if (entry.year > CURRENT_YEAR) {
      flags.push(`Anomaly: citation year (${entry.year}) is in the future`);
      score -= 20;
    }
  } else {
    score += 10;
    reasons.year = `Year check: Neutral (10/20 pts)`;
  }

  // 4. DOI & Web URL consistency
  if (hasDoi) {
    if (doiResolved && entry.doi && rec.doi && normalize(entry.doi) === normalize(rec.doi)) {
      score += 15;
      reasons.doi = `DOI verified: Exact match (${entry.doi})`;
    } else if (hasDoi && !doiResolved) {
      flags.push(`Invalid DOI: The provided DOI (${entry.doi}) does not exist in Crossref or OpenAlex`);
      score -= 30; // Heavy penalty for fabricated DOI
    }
  }

  // Web resource validation bonus
  if (rec.source && rec.source.startsWith("Web")) {
    if (rec.ok) {
      score += 20; // Verified live URL (HTTP 200)
      reasons.web = `Live Web URL: Verified reachable (HTTP ${rec.statusCode || 200}) at ${rec.siteName || 'host'}`;
    } else if (rec.error) {
      flags.push(`Broken Link: ${rec.error}`);
      score -= 25;
    }
  }

  const finalScore = Math.min(100, Math.max(0, Math.round(score)));
  return { score: finalScore, reasons, flags, titleSimilarity: titleSim };
}

export async function verifyEntry(entry) {
  const candidates = [];
  const errors = [];
  let doiResolved = false;
  let invalidDoi = false;

  // 1. If DOI is present, query Crossref and OpenAlex by DOI
  if (entry.doi) {
    try {
      const crRecord = await p.crossrefByDoi(entry.doi);
      if (crRecord) {
        candidates.push(crRecord);
        doiResolved = true;
      }
    } catch (err) {
      errors.push(`Crossref DOI error: ${err.message}`);
    }

    if (!doiResolved) {
      try {
        const oaRecord = await p.openalexByDoi(entry.doi);
        if (oaRecord) {
          candidates.push(oaRecord);
          doiResolved = true;
        }
      } catch (err) {
        errors.push(`OpenAlex DOI error: ${err.message}`);
      }
    }

    if (!doiResolved) {
      invalidDoi = true;
    }
  }

  // 2. If arXiv ID is present, query arXiv
  if (entry.arxivId) {
    try {
      const arRecord = await p.arxivById(entry.arxivId);
      if (arRecord) candidates.push(arRecord);
    } catch (err) {
      errors.push(`arXiv error: ${err.message}`);
    }
  }

  // 2b. If Web URL is present, verify live webpage/blog/documentation
  let webResult = null;
  if (entry.url && !entry.doi && !/arxiv\.org\/(?:abs|pdf)/i.test(entry.url)) {
    try {
      webResult = await p.verifyWebResource(entry.url);
      if (webResult && webResult.ok) {
        candidates.push(webResult);
      }
    } catch (err) {
      // Non-fatal
    }
  }

  // 3. Search query from title and author across scholarly databases
  const firstAuthor = entry.surnames?.[0] || "";
  const baseTitle = entry.title || (entry.raw.length > 20 ? entry.raw.slice(0, 150) : null);

  if (baseTitle && baseTitle.length >= 4) {
    // Search pure title
    try {
      const oa = await p.openalexSearch(baseTitle, 4);
      candidates.push(...oa);
    } catch (err) {
      errors.push(`OpenAlex search error: ${err.message}`);
    }

    try {
      const cr = await p.crossrefSearch(baseTitle, 4);
      candidates.push(...cr);
    } catch (err) {
      errors.push(`Crossref search error: ${err.message}`);
    }

    // Also search with author surname if available for disambiguation
    if (firstAuthor && !/arxiv\.org|doi\.org/i.test(firstAuthor)) {
      try {
        const crAuth = await p.crossrefSearch(`${firstAuthor} ${baseTitle}`, 3);
        candidates.push(...crAuth);
      } catch (err) {
        // Non-fatal
      }
    }

    // Query arXiv search for preprints and CS/AI/physics papers
    if (entry.type === "preprint" || /neural|learning|quantum|model|attention|vision|transformer/i.test(baseTitle)) {
      try {
        const ar = await p.arxivSearch(baseTitle, 3);
        candidates.push(...ar);
      } catch (err) {
        // Non-fatal
      }
    }

    // Try PubMed for biomedical / life sciences
    try {
      const pm = await p.pubmedSearch(baseTitle);
      candidates.push(...pm);
    } catch (err) {
      // Non-fatal
    }

    // Try Google Books if book or no candidates yet
    if (entry.type === "book" || candidates.length === 0) {
      try {
        const gb = await p.googleBooksSearch(baseTitle);
        candidates.push(...gb);
      } catch (err) {
        // Non-fatal
      }
    }
  }

  if (!candidates.length) {
    const flags = invalidDoi ? ["Provided DOI failed to resolve (non-existent DOI)"] : [];
    if (webResult && !webResult.ok) {
      flags.push(`Broken or unreachable web link (${webResult.error || 'HTTP error'})`);
    }
    return {
      status: "not_found",
      confidence: 0,
      message: invalidDoi
        ? `Fabricated DOI: The DOI "${entry.doi}" does not exist, and no matching academic publications were found.`
        : webResult && !webResult.ok
        ? `Broken Web Citation: The cited URL "${entry.url}" could not be reached (${webResult.error}), and no database matches exist.`
        : "No matching academic records found in Crossref, OpenAlex, arXiv, or PubMed. This entry appears to be AI-hallucinated or non-scholarly.",
      matchedRecord: null,
      matchDetails: { score: 0, reasons: {}, flags },
      diagnostics: {
        titleSimilarity: 0,
        flags: flags.length ? flags : ["No academic candidates found in scholarly registries"],
      },
      errors: errors.length ? errors : undefined,
    };
  }

  // Score each candidate against entry
  let bestCand = null;
  let bestScore = -1;
  let bestDetails = null;

  for (const cand of candidates) {
    // Check exact DOI match
    if (entry.doi && cand.doi && normalize(entry.doi) === normalize(cand.doi)) {
      const details = computeMatchScore(entry, cand, true, true);
      // Even if DOI matches, verify title doesn't wildly differ
      if (details.titleSimilarity >= 0.35 || !entry.title) {
        bestCand = cand;
        bestScore = Math.max(90, details.score);
        bestDetails = details;
        break;
      }
    }

    // Check exact arXiv match
    if (entry.arxivId && cand.source === "arXiv") {
      const details = computeMatchScore(entry, cand, false, false);
      if (details.titleSimilarity >= 0.35 || !entry.title) {
        bestCand = cand;
        bestScore = Math.max(95, details.score);
        bestDetails = details;
        break;
      }
    }

    // Check live Web / Blog match
    if (cand.source && cand.source.startsWith("Web") && cand.ok) {
      const details = computeMatchScore(entry, cand, false, false);
      if (details.titleSimilarity >= 0.35 || (entry.title && cand.title.toLowerCase().includes(entry.title.toLowerCase()))) {
        bestCand = cand;
        bestScore = Math.max(88, details.score);
        bestDetails = details;
        break;
      }
    }

    const details = computeMatchScore(entry, cand, !!entry.doi, doiResolved);
    if (details.score > bestScore) {
      bestScore = details.score;
      bestCand = cand;
      bestDetails = details;
    }
  }

  let status = "not_found";
  let message = "";

  const titleSim = bestDetails?.titleSimilarity ?? 0;
  const isIdentifierLookup = !entry.title && !!(entry.arxivId || entry.doi);
  const isExactIdentifierMatch =
    (entry.doi && bestCand?.doi && normalize(entry.doi) === normalize(bestCand.doi)) ||
    (entry.arxivId && bestCand?.source === "arXiv");

  const hasSevereFlags = bestDetails?.flags?.some((f) => /invalid|anomaly|mismatch|unconfirmed/i.test(f));

  if (!hasSevereFlags && bestScore >= 70 && (titleSim >= 0.55 || (isExactIdentifierMatch && (titleSim >= 0.3 || isIdentifierLookup)))) {
    status = "verified";
    message = `Verified successfully via ${bestCand.source} (match score: ${bestScore}/100). Metadata matches genuine academic records.`;
  } else if (!hasSevereFlags && bestScore >= 50 && (titleSim >= 0.40 || isExactIdentifierMatch)) {
    status = "needs_review";
    const flagSummary = bestDetails?.flags?.length ? ` Flags: ${bestDetails.flags.join("; ")}.` : "";
    message = `Partial match found in ${bestCand.source} (${bestScore}/100), but discrepancies exist.${flagSummary}`;
  } else {
    status = "not_found";
    message = invalidDoi
      ? `Likely Hallucinated: Provided DOI "${entry.doi}" is invalid/non-existent. Closest database match only scored ${bestScore}/100.`
      : hasSevereFlags
      ? `Likely Hallucinated: Discrepancies detected (${bestDetails.flags.join(", ")}). Closest candidate scored ${bestScore}/100.`
      : `Likely Hallucinated: Low match score (${bestScore}/100) across all databases. Title, authors, or publication venue could not be authenticated.`;
  }

  const correctedAPA = formatAPA(bestCand);
  const correctedIEEE = formatIEEE(bestCand);
  const correctedBibTeX = formatBibTeX(bestCand);

  return {
    status,
    confidence: bestScore,
    message,
    matchedRecord: bestCand,
    matchDetails: bestDetails,
    diagnostics: {
      titleSimilarity: Math.round(titleSim * 100),
      flags: bestDetails?.flags || [],
      reasons: bestDetails?.reasons || {},
    },
    correctedCitation: correctedAPA,
    citations: {
      apa: correctedAPA,
      ieee: correctedIEEE,
      bibtex: correctedBibTeX,
    },
    errors: errors.length ? errors : undefined,
  };
}
