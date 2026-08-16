/**
 * Backs up all non-STEP past-paper data (subjects, papers, questions, images,
 * bookmarks) to timestamped JSONL files in /backups/.
 *
 * JSONL = one JSON object per line. Streamable, greppable, and re-importable.
 *
 * Usage:  npx tsx scripts/backup-past-papers.ts
 */
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prisma } from '../lib/prisma';

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DIR = path.join(process.cwd(), 'backups', `pastpapers-${STAMP}`);

function writer(name: string) {
  const p = path.join(DIR, `${name}.jsonl`);
  const stream = fs.createWriteStream(p);
  return { stream, path: p };
}

async function dump<T>(
  name: string,
  iter: AsyncIterable<T>,
  count: number
): Promise<{ path: string; rows: number }> {
  const w = writer(name);
  let rows = 0;
  for await (const row of iter) {
    w.stream.write(JSON.stringify(row) + '\n');
    rows++;
    if (rows % 50000 === 0) console.log(`  ${name}: ${rows}/${count}`);
  }
  w.stream.end();
  await new Promise<void>((resolve) => w.stream.on('close', resolve));
  console.log(`  ✓ ${name}: ${rows} rows → ${path.basename(w.path)}`);
  return { path: w.path, rows };
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  console.log(`Backing up to ${DIR}`);

  const [
    subjects,
    papers,
    questions,
    images,
    bookmarks,
  ] = await Promise.all([
    prisma.subject.count(),
    prisma.pastPaper.count(),
    prisma.pastPaperQuestion.count(),
    prisma.questionImage.count(),
    prisma.pastPaperBookmark.count(),
  ]);

  console.log('Counts:', { subjects, papers, questions, images, bookmarks });

  // Stream each table. Using findMany with no limit would load everything
  // into memory at once; instead we chunk by cursor to stay memory-safe.
  async function* streamTable<T>(
    model: unknown,
    cursorField: string,
  ): AsyncIterable<T> {
    const delegate = model as { findMany: (args: Record<string, unknown>) => Promise<T[]> };
    const BATCH = 5000;
    let cursor: unknown = undefined;
    while (true) {
      const rows: T[] = await delegate.findMany({
        take: BATCH,
        ...(cursor !== undefined ? { skip: 1, cursor: { [cursorField]: cursor } } : {}),
        orderBy: { [cursorField]: 'asc' },
      });
      if (rows.length === 0) break;
      for (const r of rows) yield r;
      cursor = (rows[rows.length - 1] as Record<string, unknown>)[cursorField];
    }
  }

  await dump('subjects', streamTable<{ id: number; code: string; name: string }>(prisma.subject, 'id'), subjects);
  await dump('past_papers', streamTable<Record<string, unknown>>(prisma.pastPaper, 'id'), papers);
  await dump('past_paper_questions', streamTable<Record<string, unknown>>(prisma.pastPaperQuestion, 'id'), questions);
  await dump('question_images', streamTable<Record<string, unknown>>(prisma.questionImage, 'id'), images);
  await dump('past_paper_bookmarks', streamTable<Record<string, unknown>>(prisma.pastPaperBookmark, 'id'), bookmarks);

  // Write a manifest for easy restore.
  const manifest = { timestamp: STAMP, tables: { subjects, papers, questions, images, bookmarks } };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n✓ Backup complete at ${DIR}`);
  console.log('  manifest.json written.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
