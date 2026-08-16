/**
 * Copy the PDF.js worker into public/ so PDFViewer can serve it locally.
 *
 * The worker must come from the pdfjs-dist that *react-pdf* depends on, not the
 * top-level one: the repo has both (react-pdf pins its own nested copy), and
 * pdf.js refuses to run a worker whose version differs from its API version --
 * silently, leaving every document stuck on "Loading PDF...".
 */
import { copyFileSync, mkdirSync } from "node:fs";
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

console.log(`pdf.worker.min.mjs <- pdfjs-dist@${version}`);
