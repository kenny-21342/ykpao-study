/**
 * Load the past paper catalogue manifest into Postgres.
 *
 *   npm run papers:index          # index + load
 *   npx tsx scripts/load-paper-catalogue.ts [--dry-run] [--keep-orphan-subjects]
 *
 * Idempotent: subjects upsert by code, papers upsert by filepath. Re-running
 * after a re-index is a no-op apart from genuinely changed rows.
 *
 * Never touches past_paper_questions. Question rows reference papers by id, and
 * ids are preserved here, so extracted question data survives a reload intact.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/prisma";

const MANIFEST_PATH = path.join(process.cwd(), "data", "paper-catalogue.json");
const BATCH_SIZE = 1000;

type ManifestSubject = {
  code: string;
  name: string;
  board: string;
  qualification: string;
};

type ManifestPaper = {
  board: string;
  qualification: string;
  subject_code: string;
  subject_name: string;
  year: number;
  session: string;
  paper_number: number;
  paper_code: string;
  variant: number;
  level: string;
  timezone: string;
  doc_type: string;
  filename: string;
  filepath: string;
  page_count: number | null;
  size_bytes: number | null;
};

type Manifest = {
  generatedAt: string;
  pdfRoot: string;
  subjects: ManifestSubject[];
  papers: ManifestPaper[];
};

/** Paths are stored relative to pdf_extraction/; older rows kept the prefix. */
function normalizeFilepath(filepath: string): string {
  return filepath
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^pdf_extraction\//, "");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const keepOrphans = process.argv.includes("--keep-orphan-subjects");

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(
      `Manifest not found at ${MANIFEST_PATH}\nRun: python3 scripts/index_paper_catalogue.py`,
    );
    process.exit(1);
  }

  const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  console.log(
    `Manifest ${manifest.generatedAt}: ${manifest.papers.length} papers, ${manifest.subjects.length} subjects`,
  );

  const before = {
    papers: await prisma.pastPaper.count(),
    questions: await prisma.pastPaperQuestion.count(),
    subjects: await prisma.subject.count(),
  };
  console.log(
    `Before: ${before.papers} papers, ${before.subjects} subjects, ${before.questions} questions`,
  );

  if (dryRun) {
    const existing = await prisma.pastPaper.findMany({ select: { filepath: true } });
    const known = new Set(existing.map((p) => normalizeFilepath(p.filepath)));
    const incoming = manifest.papers.map((p) => normalizeFilepath(p.filepath));
    const added = incoming.filter((f) => !known.has(f)).length;
    console.log(`Dry run: ${added} inserts, ${incoming.length - added} updates`);
    return;
  }

  // 1. Canonicalise stored paths so filepath is a stable upsert key.
  const normalized = await prisma.$executeRaw`
    UPDATE past_papers
       SET filepath = regexp_replace(filepath, '^pdf_extraction/', '')
     WHERE filepath LIKE 'pdf_extraction/%'
  `;
  if (normalized) console.log(`Normalized ${normalized} legacy filepaths`);

  // 2. Subjects, upserted by code.
  for (const subject of manifest.subjects) {
    await prisma.subject.upsert({
      where: { code: subject.code },
      create: {
        code: subject.code,
        name: subject.name,
        board: subject.board,
        qualification: subject.qualification,
      },
      update: {
        name: subject.name,
        board: subject.board,
        qualification: subject.qualification,
      },
    });
  }
  const subjectIdByCode = new Map(
    (await prisma.subject.findMany({ select: { id: true, code: true } })).map((s) => [
      s.code,
      s.id,
    ]),
  );
  console.log(`Upserted ${manifest.subjects.length} subjects`);

  // 3. Papers. Existing rows are updated in place so their ids -- and the
  //    question rows pointing at them -- survive.
  //    A single INSERT ... ON CONFLICT per batch keeps this to a handful of
  //    round trips; row-at-a-time writes against a remote database are far too
  //    slow for ~13k papers.
  let processed = 0;
  for (const batch of chunk(manifest.papers, BATCH_SIZE)) {
    const subjectIds = batch.map((paper) => {
      const subjectId = subjectIdByCode.get(paper.subject_code);
      if (subjectId === undefined) {
        throw new Error(`No subject row for code ${paper.subject_code}`);
      }
      return subjectId;
    });

    await prisma.$executeRaw`
      INSERT INTO past_papers (
        "subjectId", year, session, "paperNumber", variant, "docType",
        filename, filepath, level, timezone, "paperCode", "pageCount", "sizeBytes"
      )
      SELECT * FROM UNNEST(
        ${subjectIds}::int[],
        ${batch.map((p) => p.year)}::int[],
        ${batch.map((p) => p.session)}::text[],
        ${batch.map((p) => p.paper_number)}::int[],
        ${batch.map((p) => p.variant)}::int[],
        ${batch.map((p) => p.doc_type)}::text[],
        ${batch.map((p) => p.filename)}::text[],
        ${batch.map((p) => normalizeFilepath(p.filepath))}::text[],
        ${batch.map((p) => p.level)}::text[],
        ${batch.map((p) => p.timezone)}::text[],
        ${batch.map((p) => p.paper_code)}::text[],
        ${batch.map((p) => p.page_count)}::int[],
        ${batch.map((p) => p.size_bytes)}::int[]
      )
      ON CONFLICT (filepath) DO UPDATE SET
        "subjectId"   = EXCLUDED."subjectId",
        year          = EXCLUDED.year,
        session       = EXCLUDED.session,
        "paperNumber" = EXCLUDED."paperNumber",
        variant       = EXCLUDED.variant,
        "docType"     = EXCLUDED."docType",
        filename      = EXCLUDED.filename,
        level         = EXCLUDED.level,
        timezone      = EXCLUDED.timezone,
        "paperCode"   = EXCLUDED."paperCode",
        "pageCount"   = EXCLUDED."pageCount",
        "sizeBytes"   = EXCLUDED."sizeBytes"
    `;

    processed += batch.length;
    console.log(`  upserted ${processed}/${manifest.papers.length}`);
  }

  // 4. Drop subject rows left behind by earlier merges -- but only once they
  //    hold nothing, so this can never orphan a paper or a discussion.
  let removed = 0;
  if (!keepOrphans) {
    const orphans = await prisma.subject.findMany({
      where: {
        papers: { none: {} },
        discussions: { none: {} },
        code: { notIn: manifest.subjects.map((s) => s.code) },
      },
      select: { id: true, code: true },
    });
    if (orphans.length) {
      await prisma.subject.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
      removed = orphans.length;
      console.log(`Removed ${removed} empty subjects: ${orphans.map((o) => o.code).join(", ")}`);
    }
  }

  const after = {
    papers: await prisma.pastPaper.count(),
    questions: await prisma.pastPaperQuestion.count(),
    subjects: await prisma.subject.count(),
  };
  console.log(
    `After: ${after.papers} papers, ${after.subjects} subjects, ${after.questions} questions`,
  );
  console.log(
    `Upserted ${processed} papers (+${after.papers - before.papers} new), removed ${removed} subjects`,
  );

  if (after.questions !== before.questions) {
    throw new Error(
      `Question count changed (${before.questions} -> ${after.questions}); the catalogue must not touch question rows`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
