import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAPA, formatIEEE, formatMLA, formatBibTeX, initials } from "../public/lib/format.js";

const article = {
  source: "Crossref",
  title: "Deep learning",
  authors: [
    { given: "Yann", family: "LeCun" },
    { given: "Yoshua", family: "Bengio" },
    { given: "Geoffrey", family: "Hinton" },
  ],
  year: 2015,
  container: "Nature",
  volume: "521",
  issue: "7553",
  pages: "436-444",
  doi: "10.1038/nature14539",
  type: "article",
};

test("initials handle hyphens and middle names", () => {
  assert.equal(initials("Ming-Wei"), "M.-W.");
  assert.equal(initials("Aidan N."), "A. N.");
  assert.equal(initials("J.R."), "J. R.");
});

test("APA 7", () => {
  assert.equal(formatAPA(article), "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539");
  assert.equal(formatAPA({ ...article, authors: [article.authors[0], article.authors[1]] }).startsWith("LeCun, Y., & Bengio, Y. (2015)."), true);
  const many = { ...article, authors: Array.from({ length: 22 }, (_, i) => ({ given: "A", family: `Author${i + 1}` })) };
  assert.match(formatAPA(many), /Author19, A\., \. \. \. Author22, A\. \(2015\)/);
});

test("IEEE", () => {
  assert.equal(formatIEEE(article), "Y. LeCun, Y. Bengio, and G. Hinton, “Deep learning,” Nature, vol. 521, no. 7553, pp. 436–444, 2015, doi: 10.1038/nature14539.");
  const seven = { ...article, authors: Array.from({ length: 7 }, (_, i) => ({ given: "Ann", family: `X${i}` })) };
  assert.match(formatIEEE(seven), /^A\. X0 et al\., /);
});

test("MLA 9", () => {
  assert.equal(formatMLA(article), "LeCun, Yann, et al. “Deep learning.” Nature, vol. 521, no. 7553, 2015, pp. 436–444. https://doi.org/10.1038/nature14539.");
});

test("BibTeX escapes and preprint fields", () => {
  const bib = formatBibTeX({ ...article, title: "R&D at 100% scale", container: "Nature" });
  assert.match(bib, /^@article\{lecun2015scale,/);
  assert.match(bib, /title\s+= \{\{R\\&D at 100\\% scale\}\}/);
  assert.match(bib, /pages\s+= \{436--444\}/);
  const pre = formatBibTeX({ source: "arXiv", title: "Attention Is All You Need", authors: [{ given: "Ashish", family: "Vaswani" }], year: 2017, arxivId: "1706.03762", type: "preprint" });
  assert.match(pre, /^@misc\{vaswani2017attention,/);
  assert.match(pre, /eprint\s+= \{1706\.03762\}/);
  assert.match(pre, /archiveprefix\s+= \{arXiv\}/);
});
