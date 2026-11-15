# VeriBib

> **The Anti-Hallucination Academic Citation & Bibliography Auditor**  
> *Created by [Koustav Kumar Mondal](https://koustav.isroot.in)*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Author](https://img.shields.io/badge/Author-Koustav%20Kumar%20Mondal-2563EB)](https://koustav.isroot.in)
[![Deploy to GitHub Pages](https://github.com/TakMashhido/VeriBib/actions/workflows/pages.yml/badge.svg)](https://github.com/TakMashhido/VeriBib/actions/workflows/pages.yml)

---

## Overview

Large Language Models (LLMs) such as ChatGPT, Claude, and Gemini frequently hallucinate academic citations—inventing fictitious titles, pairing real researchers with non-existent papers, generating fake DOIs, or placing computer science articles in biology journals.

**VeriBib** is a zero-dependency scholarly citation auditor that cross-references your references in real time against official academic registries:
- **Crossref Works & DOI Registry** (150M+ DOIs)
- **OpenAlex Global Scholarly Graph** (250M+ scientific records)
- **arXiv Preprints Repository** (2M+ preprints)
- **PubMed Biomedical Database** (36M+ biomedical citations)
- **Google Books Volumes**
- **Live Web Resources & Tech Blogs** (Lil'Log, Karpathy, technical documentation)

---

## Key Features

- **Live Web & BibTeX `@misc` Verification**: Directly validates URLs and tech blogs for HTTP 200 reachability, OpenGraph metadata, and author attribution, eliminating false hallucination flags on web citations.
- **Symmetric Title Matching**: Employs symmetric Dice token coefficients with stopword filtering and length-ratio penalties, preventing short titles from falsely matching long fabricated titles.
- **Multi-Format Parsing**: Supports APA, IEEE, BibTeX (`@article`, `@inproceedings`, `@misc`, `@online`), RIS, MLA, Chicago, bare DOIs, and bare arXiv identifiers (e.g. `1706.03762`).
- **One-Click Multi-Format Export**: Copy corrected citations in standard APA, IEEE, or clean BibTeX, or export full audit reports in `.bib`, `JSON`, or Markdown.
- **Modern Blue Claymorphism UI**: High-craft 3D tactile interface with soft puffy cards, molded sunken input wells, and squishy spring buttons.
- **Zero NPM Dependencies**: Built exclusively with native Node.js ESM modules (`node:http`, `node:fs`, `node:path`) and standard browser APIs.

---

## Quick Start

### 1. Run with Node.js Server
```bash
# Clone the repository
git clone git@github.com:TakMashhido/VeriBib.git
cd VeriBib

# Start the local auditor server (no npm install required!)
node server.js
```
Open **[http://localhost:3847](http://localhost:3847)** in your browser.

### 2. Run Statically (or via GitHub Pages)
Because VeriBib includes client-side API fallback support, you can open `index.html` directly in any modern browser or host it statically on **GitHub Pages**:
- Live Demo: **[https://takmashhido.github.io/VeriBib/](https://takmashhido.github.io/VeriBib/)**

---

## Author & Copyright

- **Author**: **Koustav Kumar Mondal**
- **Website**: [https://koustav.isroot.in](https://koustav.isroot.in)
- **Email**: [erkoustavkumar@gmail.com](mailto:erkoustavkumar@gmail.com)
- **Copyright**: &copy; 2026 Koustav Kumar Mondal. All rights reserved.

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
