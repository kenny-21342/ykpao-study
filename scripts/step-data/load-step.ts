/**
 * Loads the entire STEP question database (1986 Specimen – 2018, 1404 questions)
 * into the CompetitionQuestion table.
 *
 * Source: the official STEP database publishes a single JSON blob at
 *   https://stepdatabase.maths.org/database/database_data.json
 * containing every question's title, HTML body, tags, and image/PDF/TeX URLs.
 *
 * This script:
 *   1. Fetches the JSON (or reads a cached copy).
 *   2. For each question, downloads the .png image to /public/step-images/.
 *   3. Upserts a CompetitionQuestion row with body + tags + local image path.
 *
 * Idempotent: re-running only updates changed rows (keyed on competition+code).
 *
 * Usage:
 *   npx tsx scripts/step-data/load-step.ts              # fetch fresh + download images
 *   npx tsx scripts/step-data/load-step.ts --no-images  # skip image download
 *   npx tsx scripts/step-data/load-step.ts --limit 20   # first 20 only (smoke test)
 */
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prisma } from '../../lib/prisma';
const SOURCE_JSON = 'https://stepdatabase.maths.org/database/database_data.json';
const IMAGE_DIR = path.join(process.cwd(), 'public', 'step-images');

type RawQ = {
  question_id: number;
  title: string;       // e.g. "16-S1-Q1"
  body: string;        // HTML
  tags: string[];
};

type RawData = { total: number; page: number; pagesize: number; questions: RawQ[] };

// Parse "YY-Sn-Qm" → { yearLabel, paper, number }; null if not a real question
// (the source has a "Start" intro entry we want to skip).
function parseCode(code: string): { yearLabel: string; paper: string; number: number } | null {
  const m = /^(Spec|\d{2})-(S[123])-Q(\d{1,2})$/.exec(code);
  if (!m) return null;
  const num = parseInt(m[3], 10);
  if (!num || num < 1 || num > 20) return null;
  return { yearLabel: m[1], paper: m[2], number: num };
}

// Extract the first .png image URL and the .pdf/.tex links from the body HTML.
function extractLinks(body: string): { imageUrl: string | null; pdfUrl: string | null; texUrl: string | null } {
  const imgMatch = /<img[^>]+src="([^"]+\.png)"/i.exec(body);
  const pdfMatch = /href="([^"]+\.pdf)"/i.exec(body);
  const texMatch = /href="([^"]+\.tex)"/i.exec(body);
  const abs = (u: string | null) => (u && u.startsWith('/') ? `https://stepdatabase.maths.org${u}` : u);
  return {
    imageUrl: abs(imgMatch?.[1] ?? null),
    pdfUrl: abs(pdfMatch?.[1] ?? null),
    texUrl: abs(texMatch?.[1] ?? null),
  };
}

// Strip the trailing pdf/tex link block from the body so it doesn't render
// as broken links in our UI. Keep the descriptive text + image.
function cleanBody(body: string): string {
  return body
    .replace(/<a class="linkpdf"[^>]*><\/a>/gi, '')
    .replace(/<a\s+class="linktex"[^>]*><\/a>/gi, '')
    .replace(/<p>\s*<\/p>/gi, '')
    .trim();
}

async function downloadImage(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

// Run async operations with bounded concurrency to avoid hammering the source.
async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const skipImages = args.has('--no-images');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

  console.log('Fetching STEP database JSON…');
  const res = await fetch(SOURCE_JSON);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  const data = (await res.json()) as RawData;

  if (!skipImages) fs.mkdirSync(IMAGE_DIR, { recursive: true });

  let processed = 0;
  let imagesOk = 0;
  let imagesFail = 0;

  const questions = data.questions.filter((q) => parseCode(q.title));
  console.log(`Source has ${data.questions.length} entries; ${questions.length} are real questions.`);

  const slice = limit > 0 ? questions.slice(0, limit) : questions;

  // Phase 1 — pre-download images with 8× concurrency.
  const localImageMap = new Map<string, string>();
  if (!skipImages) {
    console.log('Downloading images (8× concurrency)…');
    await pMap(slice, 8, async (q) => {
      const links = extractLinks(q.body);
      if (!links.imageUrl) return;
      const filename = `${q.title}.png`;
      const dest = path.join(IMAGE_DIR, filename);
      if (fs.existsSync(dest)) {
        localImageMap.set(q.title, `/step-images/${filename}`);
      } else {
        const ok = await downloadImage(links.imageUrl, dest);
        if (ok) localImageMap.set(q.title, `/step-images/${filename}`);
      }
    });
    console.log('  images ready.');
  }

  // Phase 2 — upsert rows (DB ops run sequentially to keep the log ordered).
  for (const q of slice) {
    const parsed = parseCode(q.title)!;
    const links = extractLinks(q.body);
    const localImage = localImageMap.get(q.title) ?? null;
    if (localImage) imagesOk++; else if (links.imageUrl) imagesFail++;

    let body = cleanBody(q.body);
    if (localImage && links.imageUrl) {
      body = body.replace(links.imageUrl, localImage);
    }

    await prisma.competitionQuestion.upsert({
      where: { competition_code: { competition: 'STEP', code: q.title } },
      create: {
        competition: 'STEP',
        code: q.title,
        yearLabel: parsed.yearLabel,
        paper: parsed.paper,
        number: parsed.number,
        title: q.title,
        body,
        labels: q.tags.map((t) => t.replace(/[,;]\s*$/, '').trim()).filter(Boolean),
        imageUrl: localImage ?? links.imageUrl,
        pdfUrl: links.pdfUrl,
        texUrl: links.texUrl,
        sourceSite: 'stepdatabase.maths.org',
      },
      update: {
        body,
        labels: q.tags.map((t) => t.replace(/[,;]\s*$/, '').trim()).filter(Boolean),
        imageUrl: localImage ?? links.imageUrl,
        pdfUrl: links.pdfUrl,
        texUrl: links.texUrl,
      },
    });

    processed++;
    if (processed % 200 === 0) {
      console.log(`  …${processed}/${slice.length} upserted`);
    }
  }

  console.log(`\n✓ Done. ${processed} questions upserted.`);
  if (!skipImages) {
    console.log(`  Images: ${imagesOk} ok, ${imagesFail} failed.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
