/**
 * Copy the PDF.js runtime assets into public/ so PDFViewer can serve them
 * locally: the worker, the character maps, and the standard font data.
 *
 * All three must come from the pdfjs-dist that *react-pdf* depends on, not the
 * top-level one: the repo has both (react-pdf pins its own nested copy), and
 * pdf.js refuses to run a worker whose version differs from its API version --
 * silently, leaving every document stuck on "Loading PDF...".
 *
 * cmaps/ and standard_fonts/ were previously fetched from unpkg.com at render
 * time. That put a third-party CDN on the critical path of every PDF: if unpkg
 * is slow, blocked, or down, pages render with missing glyphs rather than
 * failing loudly, and a strict Content-Security-Policy blocks them outright.
 * cmaps in particular are what render non-Latin and embedded-font text, which
 * past papers do contain. 2.4 MB of static assets is a cheap trade for removing
 * a runtime dependency on someone else's uptime.
 */
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const reactPdfDir = path.dirname(require.resolve("react-pdf/package.json", { paths: [repoRoot] }));
const workerPath = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs", { paths: [reactPdfDir] });
const version = require(path.join(workerPath, "../../package.json")).version;

const destination = path.join(repoRoot, "public", "pdf.worker.min.mjs");
mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(workerPath, destination);

// Resolve the asset directories from the same package.json the worker came
// from, so a version bump can never leave cmaps behind at an older revision.
const pdfjsDir = path.resolve(workerPath, "..", "..");
const assetRoot = path.join(repoRoot, "public", "pdfjs");

for (const asset of ["cmaps", "standard_fonts"]) {
  const from = path.join(pdfjsDir, asset);
  const to = path.join(assetRoot, asset);
  // Remove first: cpSync merges into an existing tree, so a file dropped
  // upstream would linger forever and be served at the wrong version.
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

console.log(`pdf.worker.min.mjs + cmaps/ + standard_fonts/ <- pdfjs-dist@${version}`);
