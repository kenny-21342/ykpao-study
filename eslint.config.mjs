import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Static assets and vendored bundles. public/pdf.worker.min.mjs alone is
    // a 1 MB minified file copied in by `npm run pdf:worker`; linting it
    // produced ~1,478 of the repo's ~1,510 reported problems and buried the
    // real ones in application code.
    "public/**",
    "generated/**",

    // Python pipeline workspace — not JavaScript, and huge.
    "pdf_extraction/**",
    ".venv-bank/**",
    "backups/**",
  ]),
]);

export default eslintConfig;
