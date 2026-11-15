import { test } from "node:test";
import assert from "node:assert/strict";
import { splitReferences, extractFields, detectBibliography, cleanDoi, cleanLatex } from "../public/lib/parse.js";
import { titleSimilarity } from "../public/lib/fuzzy.js";

test("splits numbered APA references and extracts fields", () => {
  const text = `[1] Vaswani, A., Shazeer, N., & Polosukhin, I. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30.
[2] He, K., Zhang, X., Ren, S., & Sun, J. (2016). Deep residual learning for image recognition. IEEE Conference on Computer Vision and Pattern Recognition (CVPR), 770-778.`;
  const entries = splitReferences(text);
  assert.equal(entries.length, 2);
  const a = extractFields(entries[0]);
  assert.equal(a.title, "Attention is all you need");
  assert.deepEqual(a.surnames, ["vaswani", "shazeer", "polosukhin"]);
  assert.equal(a.year, 2017);
  const b = extractFields(entries[1]);
  assert.deepEqual(b.surnames, ["he", "zhang", "ren", "sun"]);
  assert.equal(b.pages, "770-778");
  assert.equal(b.venue, "IEEE Conference on Computer Vision and Pattern Recognition (CVPR)");
  assert.equal(detectBibliography(entries).style, "apa");
});

test("one identifier per line becomes one entry each", () => {
  const entries = splitReferences("10.1145/3065386\n1706.03762\nhttps://doi.org/10.1038/nature14539\narXiv:2103.00020");
  assert.equal(entries.length, 4);
  const ax = extractFields("1706.03762");
  assert.equal(ax.arxivId, "1706.03762");
  assert.equal(ax.year, null, "an arXiv id is not a year");
  assert.equal(extractFields("arXiv:2103.00020").title, undefined, "identifier label is not a title");
});

test("a wrapped DOI line stays with its reference", () => {
  const entries = splitReferences("LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521, 436-444.\nhttps://doi.org/10.1038/nature14539");
  assert.equal(entries.length, 1);
  assert.equal(extractFields(entries[0]).doi, "10.1038/nature14539");
});

test("IEEE quoted titles lose trailing punctuation", () => {
  const f = extractFields('[1] K. He, X. Zhang, S. Ren, and J. Sun, "Deep residual learning for image recognition," in Proc. CVPR, 2016, pp. 770-778.');
  assert.equal(f.title, "Deep residual learning for image recognition");
  assert.deepEqual(f.surnames, ["he", "zhang", "ren", "sun"]);
  assert.equal(f.year, 2016);
});

test("Vancouver authors are not mistaken for the title", () => {
  const f = extractFields("Smith JR, Doe A. A study of things in mice. N Engl J Med. 2003;348(5):1-10.");
  assert.equal(f.title, "A study of things in mice");
  assert.deepEqual(f.surnames, ["smith", "doe"]);
  assert.equal(f.year, 2003);
});

test("MLA with accented names", () => {
  const f = extractFields('Müller, Jürgen, and Anna van der Berg. "Über die Theorie der Dinge." Zeitschrift für Physik, vol. 12, no. 3, 1999, pp. 1-20.');
  assert.equal(f.title, "Über die Theorie der Dinge");
  assert.equal(f.surnames[0], "muller");
  assert.equal(f.year, 1999);
});

test("BibTeX with nested braces, LaTeX accents and mixed plain text", () => {
  const text = `[1] Weng, L. (2023). LLM-powered autonomous agents. Lil'Log. https://lilianweng.github.io/posts/2023-06-23-agent/
[2] @misc{key,
  author = {G{\\"o}del, Kurt and {World Health Organization}},
  title = {{BERT} and the {\\"U}ber guide \\& more},
  howpublished = {\\url{https://example.org/post}},
  year = 2023
}`;
  const entries = splitReferences(text);
  assert.equal(entries.length, 2);
  const f = extractFields(entries[1]);
  assert.equal(f.format, "bibtex");
  assert.equal(f.title, "BERT and the Über guide & more");
  assert.deepEqual(f.authors.map((a) => a.family), ["Gödel", "World Health Organization"]);
  assert.equal(f.url, "https://example.org/post");
  assert.equal(f.year, 2023);
  assert.equal(f.type, "misc");
});

test("BibTeX eprint becomes an arXiv id", () => {
  const f = extractFields("@misc{r, title={CLIP}, author={Radford, Alec and others}, year={2021}, eprint={2103.00020}, archivePrefix={arXiv}}");
  assert.equal(f.arxivId, "2103.00020");
  assert.equal(f.type, "preprint");
  assert.deepEqual(f.surnames, ["radford"]);
});

test("RIS records", () => {
  const ris = "TY  - JOUR\nAU  - LeCun, Yann\nAU  - Bengio, Yoshua\nTI  - Deep learning\nJO  - Nature\nPY  - 2015\nDO  - 10.1038/nature14539\nER  - \nTY  - BOOK\nAU  - Goodfellow, Ian\nTI  - Deep Learning\nPY  - 2016\nPB  - MIT Press\nER  - ";
  const entries = splitReferences(ris);
  assert.equal(entries.length, 2);
  const a = extractFields(entries[0]);
  assert.equal(a.doi, "10.1038/nature14539");
  assert.deepEqual(a.surnames, ["lecun", "bengio"]);
  assert.equal(extractFields(entries[1]).type, "book");
});

test("cleanDoi trims punctuation but keeps balanced parentheses", () => {
  assert.equal(cleanDoi("(DOI: 10.1016/j.fake.2023.03.099)."), "10.1016/j.fake.2023.03.099");
  assert.equal(cleanDoi("10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0").startsWith("10.1002/(SICI)1097-4571(199806)49:8"), true);
});

test("cleanLatex", () => {
  assert.equal(cleanLatex("Schr{\\\"o}dinger --- {\\'E}cole"), "Schrödinger — École");
});

test("title similarity is symmetric and resists padded fakes", () => {
  assert.equal(titleSimilarity("Attention is all you need", "Attention Is All You Need"), 1);
  assert.ok(titleSimilarity("Deep residual learning", "Deep Residual Learning for Image Recognition") >= 0.8);
  assert.ok(titleSimilarity("Quantum supremacy in recursive neural networks with non-abelian gauge fields", "Recursive neural networks - Six degree-of-freedom maneuvering simulation capabilities") < 0.55);
  assert.ok(titleSimilarity("ImageNet classification with deep convolutional neural networks", "Deep learning") < 0.3);
});
