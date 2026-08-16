/**
 * Generates public/sw.js from scripts/sw-template.js, stamping in a
 * CACHE_VERSION that changes whenever the deployed code changes.
 *
 * Without this the service worker's cache key was a hand-maintained 'v1' that
 * nobody remembered to bump, so caches from previous deploys were never
 * evicted: a returning user could be served the old build's HTML, which
 * references content-hashed /_next/static chunks that the new deploy deleted,
 * and the app white-screens.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * Prefer a deploy-provided build id so every instance of a deploy agrees on
 * one version. Vercel exposes the commit SHA; fall back to a hash of the
 * template plus the current time for local builds.
 */
function resolveBuildId(templateSource) {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.BUILD_ID;
  if (fromEnv) return fromEnv.slice(0, 12);

  return createHash('sha256')
    .update(templateSource)
    .update(String(Date.now()))
    .digest('hex')
    .slice(0, 12);
}

const templatePath = join(root, 'scripts', 'sw-template.js');
const outputPath = join(root, 'public', 'sw.js');

const template = await readFile(templatePath, 'utf8');

if (!template.includes('__CACHE_VERSION__')) {
  throw new Error(
    'scripts/sw-template.js no longer contains the __CACHE_VERSION__ placeholder; ' +
      'the generated service worker would never bust its caches.',
  );
}

const version = resolveBuildId(template);
await writeFile(outputPath, template.replaceAll('__CACHE_VERSION__', version));

console.log(`[build-sw] wrote public/sw.js (CACHE_VERSION=${version})`);
