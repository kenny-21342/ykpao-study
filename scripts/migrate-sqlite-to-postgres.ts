/**
 * Migrate SQLite papers.db → Postgres (Prisma).
 *
 * Handles: subjects, papers (filepath-unique), questions (with doc_type),
 * and question_images (coordinate-linked figures).
 *
 * Idempotent via upsert / skipDuplicates. Run with: npx tsx scripts/migrate-sqlite-to-postgres.ts
 */
import "dotenv/config";
import Database from "better-sqlite3";
import path from "node:path";
import { prisma } from "../lib/prisma";
import { reindexRagCorpus } from "../lib/rag-index";

const SQLITE_PATH = path.join(process.cwd(), "papers.db");
const BATCH_SIZE = 2000;

function log(label: string, n: number, total?: number) {
  const pct = total ? ` (${((n / total) * 100).toFixed(1)}%)` : "";
  console.log(`  ${label}: ${n.toLocaleString()}${pct}`);
}

// Use Prisma's own input types so the shape is always correct (fixes Problem 9).
type SubjectCreate = { id: number; code: string; name: string };
type PaperCreate = {
  id: number;
  subjectId: number;
  year: number;
  session: string;
  paperNumber: number;
  variant: number;
  docType: string;
  filename: string;
  filepath: string;
  fileHash: string | null;
  totalMarks: number;
  insertText: string;
  processedAt: string | null;
};
type QuestionCreate = {
  id: number;
  paperId: number;
  number: number;
  part: string;
  subPart: string;
  content: string;
  latex: string;
  marks: number;
  hasDiagram: number;
  diagramRef: string;
  ordering: number;
  docType: string;
};
type QuestionImageCreate = {
  questionId: number;
  imagePath: string;
  pageNumber: number | null;
  bboxX0: number | null;
  bboxY0: number | null;
  bboxX1: number | null;
  bboxY1: number | null;
};

async function migrate() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  sqlite.pragma("journal_mode = WAL");

  console.log(`Source: ${SQLITE_PATH}`);

  const counts: Record<string, number> = {
    subjects: (sqlite.prepare("SELECT COUNT(*) AS n FROM subjects").get() as { n: number }).n,
    papers: (sqlite.prepare("SELECT COUNT(*) AS n FROM papers").get() as { n: number }).n,
    questions: (sqlite.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n,
  };
  let imagesTable = true;
  try {
    counts["images" as keyof typeof counts] = (sqlite.prepare("SELECT COUNT(*) AS n FROM question_images").get() as { n: number }).n;
  } catch {
    imagesTable = false;
    console.log("  (no question_images table in source — skipping image migration)");
  }
  console.log(
    `SQLite: ${counts.subjects} subjects, ${counts.papers} papers, ${counts.questions} questions` +
    (imagesTable ? `, ${counts.images} images` : "")
  );

  // [1/4] Subjects
  console.log("\n[1/4] Migrating subjects...");
  const subjects = sqlite.prepare("SELECT * FROM subjects ORDER BY id").all() as Record<string, unknown>[];
  for (const s of subjects) {
    const row: SubjectCreate = { id: s.id as number, code: s.code as string, name: s.name as string };
    await prisma.subject.upsert({
      where: { id: row.id },
      create: row,
      update: { code: row.code, name: row.name },
    });
  }
  log("subjects", subjects.length);

  // [2/4] Papers
  console.log("\n[2/4] Migrating papers...");
  const paperCount = counts.papers;
  const paperStmt = sqlite.prepare("SELECT * FROM papers ORDER BY id");
  let migratedPapers = 0;
  let paperBatch: PaperCreate[] = [];
  for (const p of paperStmt.iterate() as IterableIterator<Record<string, unknown>>) {
    paperBatch.push({
      id: p.id as number,
      subjectId: p.subject_id as number,
      year: p.year as number,
      session: p.session as string,
      paperNumber: p.paper_number as number,
      variant: (p.variant as number) ?? 0,
      docType: p.doc_type as string,
      filename: p.filename as string,
      filepath: p.filepath as string,
      fileHash: (p.file_hash as string) ?? null,
      totalMarks: (p.total_marks as number) ?? 0,
      insertText: (p.insert_text as string) ?? "",
      processedAt: (p.processed_at as string) ?? null,
    });
    if (paperBatch.length >= BATCH_SIZE) {
      await prisma.pastPaper.createMany({ data: paperBatch, skipDuplicates: true });
      migratedPapers += paperBatch.length;
      log("papers", migratedPapers, paperCount);
      paperBatch = [];
    }
  }
  if (paperBatch.length) {
    await prisma.pastPaper.createMany({ data: paperBatch, skipDuplicates: true });
    migratedPapers += paperBatch.length;
    log("papers", migratedPapers, paperCount);
  }

  // [3/4] Questions (with doc_type)
  console.log("\n[3/4] Migrating questions...");
  const questionCount = counts.questions;
  const qStmt = sqlite.prepare("SELECT * FROM questions ORDER BY id");
  let migratedQs = 0;
  let qBatch: QuestionCreate[] = [];
  for (const q of qStmt.iterate() as IterableIterator<Record<string, unknown>>) {
    qBatch.push({
      id: q.id as number,
      paperId: q.paper_id as number,
      number: q.number as number,
      part: (q.part as string) ?? "",
      subPart: (q.sub_part as string) ?? "",
      content: q.content as string,
      latex: (q.latex as string) ?? "",
      marks: (q.marks as number) ?? 0,
      hasDiagram: (q.has_diagram as number) ?? 0,
      diagramRef: (q.diagram_ref as string) ?? "",
      ordering: (q.ordering as number) ?? 0,
      docType: (q.doc_type as string) ?? "qp",
    });
    if (qBatch.length >= BATCH_SIZE) {
      await prisma.pastPaperQuestion.createMany({ data: qBatch, skipDuplicates: true });
      migratedQs += qBatch.length;
      log("questions", migratedQs, questionCount);
      qBatch = [];
    }
  }
  if (qBatch.length) {
    await prisma.pastPaperQuestion.createMany({ data: qBatch, skipDuplicates: true });
    migratedQs += qBatch.length;
    log("questions", migratedQs, questionCount);
  }

  // [4/4] Question images (if table exists in source)
  if (imagesTable) {
    console.log("\n[4/4] Migrating question images...");
    const imgStmt = sqlite.prepare("SELECT * FROM question_images ORDER BY id");
    let migratedImgs = 0;
    let imgBatch: QuestionImageCreate[] = [];
    for (const im of imgStmt.iterate() as IterableIterator<Record<string, unknown>>) {
      imgBatch.push({
        questionId: im.question_id as number,
        imagePath: im.image_path as string,
        pageNumber: (im.page_number as number) ?? null,
        bboxX0: (im.bbox_x0 as number) ?? null,
        bboxY0: (im.bbox_y0 as number) ?? null,
        bboxX1: (im.bbox_x1 as number) ?? null,
        bboxY1: (im.bbox_y1 as number) ?? null,
      });
      if (imgBatch.length >= BATCH_SIZE) {
        await prisma.questionImage.createMany({ data: imgBatch });
        migratedImgs += imgBatch.length;
        log("images", migratedImgs, counts.images);
        imgBatch = [];
      }
    }
    if (imgBatch.length) {
      await prisma.questionImage.createMany({ data: imgBatch });
      migratedImgs += imgBatch.length;
      log("images", migratedImgs, counts.images);
    }
  }

  sqlite.close();

  // Reconciliation
  const finalSubjects = await prisma.subject.count();
  const finalPapers = await prisma.pastPaper.count();
  const finalQuestions = await prisma.pastPaperQuestion.count();
  console.log("\n=== Migration complete ===");
  console.log(`Postgres: ${finalSubjects} subjects, ${finalPapers} papers, ${finalQuestions} questions`);
  const rag = await reindexRagCorpus();
  console.log(`RAG index: ${rag.indexed.toLocaleString()} source records, ${rag.manifests.toLocaleString()} manifests`);
  if (finalSubjects !== counts.subjects || finalPapers !== counts.papers || finalQuestions !== counts.questions) {
    console.warn("⚠️  Row counts differ from source — investigate before deleting papers.db");
    process.exitCode = 1;
  } else {
    console.log("✅ Counts match source.");
  }
}

migrate()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
