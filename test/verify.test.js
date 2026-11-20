// Verdict logic against stubbed registry responses (no network).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __resetForTests } from "../public/lib/providers.js";
import { verifyEntry } from "../public/lib/verify.js";
import { extractFields } from "../public/lib/parse.js";
import { auditBibliography } from "../public/lib/audit.js";

let routes = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  const u = String(url);
  for (const [re, fn] of routes) if (re.test(u)) return fn(u);
  return json({ message: "not found" }, 404);
};

const cr = (DOI, title, authors, year, container = "Nature") => ({
  DOI,
  title: [title],
  author: authors.map((family) => ({ given: "A.", family })),
  issued: { "date-parts": [[year]] },
  "container-title": [container],
  type: "journal-article",
});
const crSearch = (...items) => [/api\.crossref\.org\/works\?/, () => json({ message: { items } })];

const LECUN = cr("10.1038/nature14539", "Deep learning", ["LeCun", "Bengio", "Hinton"], 2015);
const IMAGENET = cr("10.1145/3065386", "ImageNet classification with deep convolutional neural networks", ["Krizhevsky", "Sutskever", "Hinton"], 2017, "Communications of the ACM");
const UNRELATED = cr("10.1/unrelated", "Nursing education in a new light", ["Okoro"], 2021, "Nurse Education Today");

const check = (text) => verifyEntry(extractFields(text));

beforeEach(() => {
  __resetForTests();
  routes = [];
});

test("a real paper found by title search is verified", async () => {
  routes.push(crSearch(LECUN));
  const v = await check("LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436-444.");
  assert.equal(v.status, "verified");
  assert.equal(v.matchedRecord.doi, "10.1038/nature14539");
  assert.ok(v.confidence >= 90);
  assert.ok(v.citations.apa.startsWith("LeCun, A., Bengio, A., & Hinton, A. (2015). Deep learning."));
});

test("a DOI that no agency has registered is flagged as fabricated", async () => {
  routes.push(crSearch(UNRELATED));
  routes.push([/doi\.org\/api\/handles/, () => json({ responseCode: 100 }, 404)]);
  const v = await check("Smith, J. (2023). Quantum supremacy in recursive gauge fields. Journal of Impossible Physics, 45(2), 1-9. https://doi.org/10.1016/j.fakephys.2023.03.099");
  assert.equal(v.status, "not_found");
  assert.match(v.message, /DOI 10\.1016\/j\.fakephys\.2023\.03\.099 does not exist/);
  assert.equal(v.checks.find((c) => c.id === "doi").status, "fail");
  assert.equal(v.matchedRecord, null);
  assert.equal(v.citations, null);
});

test("a real DOI attached to a different paper is caught", async () => {
  routes.push([/api\.crossref\.org\/works\/10\.1145/, () => json({ message: IMAGENET })]);
  routes.push(crSearch(UNRELATED));
  const v = await check("Johnson, M. (2019). Dropout as a universal regularizer. Nature, 521, 436-444. https://doi.org/10.1145/3065386");
  assert.equal(v.status, "not_found");
  assert.ok(v.flags.some((f) => /belongs to a different work/.test(f.text)));
  assert.equal(v.checks.find((c) => c.id === "doi").status, "fail");
});

test("the right paper with a wrong DOI needs review rather than passing", async () => {
  routes.push([/api\.crossref\.org\/works\/10\.1145/, () => json({ message: IMAGENET })]);
  routes.push(crSearch(LECUN));
  const v = await check("LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521, 436-444. https://doi.org/10.1145/3065386");
  assert.equal(v.status, "needs_review");
  assert.match(v.message, /points to a different paper/);
});

test("a real title credited to the wrong authors is not verified", async () => {
  routes.push(crSearch(LECUN));
  const v = await check("Smith, A., & Jones, B. (2015). Deep learning. Nature, 521, 436-444.");
  assert.equal(v.status, "not_found");
  assert.match(v.message, /different authors/);
});

test("a registry outage is reported as unchecked, not fabricated", async () => {
  routes.push([/crossref|openalex|datacite|ncbi|googleapis|arxiv/, () => json({ error: "down" }, 500)]);
  const v = await check("Doe, J. (2020). A perfectly ordinary paper about soil. Soil Journal, 3, 1-2.");
  assert.equal(v.status, "needs_review");
  assert.match(v.message, /could not be fully checked/);
});

test("year drift: one year is fine, four years is not", async () => {
  routes.push(crSearch(LECUN));
  const ok = await check("LeCun, Y., Bengio, Y., & Hinton, G. (2016). Deep learning. Nature, 521, 436-444.");
  assert.equal(ok.status, "verified");
  __resetForTests();
  const off = await check("LeCun, Y., Bengio, Y., & Hinton, G. (2019). Deep learning. Nature, 521, 436-444.");
  assert.notEqual(off.status, "verified");
  assert.ok(off.flags.some((f) => /Cited year 2019/.test(f.text)));
});

test("a future publication year is flagged", async () => {
  routes.push(crSearch(UNRELATED));
  const year = new Date().getFullYear() + 2;
  const v = await check(`Feynman, R. P. (${year}). General relativity on quantum silicon wafers. Quantum Computing Letters, 12(4), 300-315.`);
  assert.equal(v.status, "not_found");
  assert.ok(v.flags.some((f) => /in the future/.test(f.text)));
});

test("audit summarizes and flags duplicates", async () => {
  routes.push(crSearch(LECUN));
  const text = "[1] LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521, 436-444.\n[2] LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521, 436-444.";
  const seen = [];
  const out = await auditBibliography(text, { onResult: (r) => seen.push(r.index) });
  assert.equal(out.summary.total, 2);
  assert.equal(out.summary.verified, 2);
  assert.deepEqual(seen.sort(), [1, 2]);
  assert.ok(out.results[1].verification.flags.some((f) => /Duplicate of reference #1/.test(f.text)));
});

test("a cited issue (print) year is not flagged when the record was first published online a year or two earlier", async () => {
  const item = { ...cr("10.1000/journal.2018.001", "A study of reproducible things", ["Smith", "Lee"], 2018, "Journal of Stuff"), issued: { "date-parts": [[2018]] }, "published-online": { "date-parts": [[2018]] }, "published-print": { "date-parts": [[2020]] } };
  routes.push(crSearch(item));
  const v = await check("Smith, A., & Lee, A. (2020). A study of reproducible things. Journal of Stuff, 12(3), 45-60.");
  assert.equal(v.status, "verified");
  assert.ok(!v.flags.some((f) => f.code === "year"), "no year conflict");
  assert.equal(v.checks.find((c) => c.id === "year").status, "pass");
});

test("a genuinely wrong year is still flagged", async () => {
  const item = { ...cr("10.1000/journal.2018.001", "A study of reproducible things", ["Smith", "Lee"], 2018, "Journal of Stuff"), "published-print": { "date-parts": [[2019]] } };
  routes.push(crSearch(item));
  const v = await check("Smith, A., & Lee, A. (2024). A study of reproducible things. Journal of Stuff, 12(3), 45-60.");
  assert.notEqual(v.status, "verified");
  assert.ok(v.flags.some((f) => f.code === "year"));
});

test("an Epub year in the citation also counts against the record", async () => {
  routes.push(crSearch(cr("10.1000/x", "A study of reproducible things", ["Smith", "Lee"], 2018, "Journal of Stuff")));
  const v = await check("Smith A, Lee A. A study of reproducible things. J Stuff. 2020;12(3):45-60. Epub 2018 Dec 5.");
  assert.equal(v.status, "verified");
  assert.equal(v.checks.find((c) => c.id === "year").status, "pass");
});
