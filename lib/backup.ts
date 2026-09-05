import { gzipSync } from 'node:zlib';
import { prisma } from '@/lib/prisma';
import { getStorage } from '@/lib/storage';

/**
 * Nightly logical backup of the data that cannot be rebuilt.
 *
 * Neon's `main` branch is unprotected and on default history retention, which
 * is not a backup: it does not survive a dropped table noticed a week later,
 * and it is not a file anyone can hold. This writes a compressed JSON snapshot
 * to the same R2 bucket the papers live in.
 *
 * WHAT IS INCLUDED, AND WHY NOT EVERYTHING: the database is ~70 tables, and
 * most of it is reproducible. The paper corpus, the question bank, the RAG
 * index and the course catalogue are all outputs of pipelines that can be run
 * again -- and the RAG chunks carry embeddings that would dominate the dump
 * while being the cheapest thing to regenerate. Backing them up nightly
 * through a 60s function would time out and protect nothing.
 *
 * What is irreplaceable is what people typed: accounts, notes, pages,
 * discussions, attempts, enrolments, spend history. That is what this saves.
 * A restore therefore assumes the corpus is re-ingested first, and then this
 * snapshot is layered on top.
 */

/**
 * Tables worth saving. Order matters only for readability; a restore has to
 * resolve foreign keys itself.
 */
const BACKED_UP_TABLES = [
  // Identity. `Account` carries the OAuth link -- without it a restored user
  // signing in with Google is issued a *new* row and their data is orphaned.
  'user',
  'account',
  // Enrolment and learning state.
  'userCourse',
  'learningProfile',
  'studyTask',
  'reviewItem',
  'studySession',
  // Written work.
  'note',
  'noteFolder',
  'noteComment',
  'noteRating',
  'noteCollaborator',
  'sharedNote',
  'notebook',
  'section',
  'page',
  'pageSnapshot',
  'pageCollaborator',
  'pageComment',
  // Community.
  'discussionThread',
  'discussionPost',
  'discussionVote',
  'discussionFlag',
  'announcement',
  'notification',
  'follow',
  // Practice history.
  'mockExam',
  'mockExamItem',
  'questionAttempt',
  // The bank is the corpus students actually practise on, so this is the
  // largest body of real work here -- and it was missing. It also carries the
  // self-marking readings, which cannot be reconstructed from anything else.
  'bankQuestionAttempt',
  'pastPaperAttempt',
  'dailyChallengeAttempt',
  'bookmark',
  'pastPaperBookmark',
  // Conversations and the money they cost.
  'aIConversation',
  'aIMessage',
  'aIActionProposal',
  'usageRecord',
  // Grade boundaries. Content rather than typing, but not re-ingestible: they
  // are parsed from coordinator PDFs that only exist on one laptop, and a
  // predicted grade is wrong without them. Topic links are deliberately absent
  // by contrast -- those live in the local extract.db and merge back without
  // paying the tagger again.
  'gradeBoundary',
  // Uploaded resources (the files themselves already live in the bucket).
  'schoolResource',
  'cloudDocument',
] as const;

/**
 * Deliberately excluded, recorded here so the next person does not have to
 * work out whether it was an oversight:
 *
 * - question, subject, pastPaper, pastPaperQuestion, questionImage, bank*:
 *   the corpus, re-ingested from the pipeline.
 * - ragDocument, ragChunk, ragCorpusManifest: a rebuildable index, and the
 *   embeddings would be most of the bytes.
 * - course, courseCurriculumScope: `ensureCourseCatalog()` recreates these on
 *   every onboarding request.
 * - session, verificationToken, rateLimit, errorEvent: transient.
 * - userAiCredential: encrypted with a key held in the environment, so a
 *   restored row is useless if that key ever changes, and copying encrypted
 *   student API keys into a second store buys nothing. Students re-enter them.
 */

/** Per-table row cap. A runaway table should truncate the dump, not the run. */
const MAX_ROWS_PER_TABLE = 100_000;

/** Backups older than this are deleted on each successful run. */
const RETENTION_DAYS = 30;

export type BackupResult = {
  key: string;
  bytes: number;
  tables: Record<string, number>;
  truncated: string[];
  prunedKeys: number;
  durationMs: number;
};

type Delegate = { findMany: (args?: unknown) => Promise<unknown[]> };

export async function runBackup(): Promise<BackupResult> {
  const startedAt = Date.now();
  const client = prisma as unknown as Record<string, Delegate>;

  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const truncated: string[] = [];

  for (const name of BACKED_UP_TABLES) {
    const delegate = client[name];
    if (!delegate?.findMany) {
      // A model renamed in schema.prisma should be loud, not silently dropped
      // from every future backup.
      throw new Error(`Backup table "${name}" is not a Prisma model`);
    }
    const rows = await delegate.findMany({ take: MAX_ROWS_PER_TABLE });
    tables[name] = rows;
    counts[name] = rows.length;
    if (rows.length === MAX_ROWS_PER_TABLE) truncated.push(name);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    meta: {
      takenAt: new Date().toISOString(),
      schemaNote:
        'Partial snapshot: user-generated data only. Re-ingest the paper corpus and RAG index separately.',
      truncated,
    },
    tables,
  };

  // BigInt has no JSON representation and would throw mid-stringify; Dates
  // serialise to ISO on their own.
  const json = JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  const body = gzipSync(Buffer.from(json, 'utf8'));

  const store = getStorage();
  const key = `backups/${stamp}.json.gz`;
  // Large dumps are fine: the s3 driver switches to multipart past 32 MiB.
  await store.put(key, body, {
    contentType: 'application/gzip',
    cacheControl: 'private, no-store',
  });

  let prunedKeys = 0;
  try {
    const existing = await store.list('backups/', 1000);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const existingKey of existing) {
      if (existingKey === key) continue;
      // `backups/2026-08-24T03-00-00-000Z.json.gz` -> the date portion.
      const iso = existingKey.slice('backups/'.length, existingKey.indexOf('.json.gz'));
      const takenAt = Date.parse(
        iso.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'),
      );
      if (Number.isFinite(takenAt) && takenAt < cutoff) {
        await store.delete(existingKey);
        prunedKeys++;
      }
    }
  } catch {
    // Pruning is housekeeping. A backup that uploaded is a success even if the
    // old ones could not be tidied.
  }

  return {
    key,
    bytes: body.byteLength,
    tables: counts,
    truncated,
    prunedKeys,
    durationMs: Date.now() - startedAt,
  };
}
