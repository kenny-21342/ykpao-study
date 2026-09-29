import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { extractFileText, isRetrievableText } from '@/lib/rag-file-text';
// `indexedRoute` in the same module resolves this link for the documents
// already written with a bare `/bank`, so both halves cannot drift.
import { BANK_QUESTION_ROUTE } from '@/lib/rag-routes';
import { folderPathFor } from '@/lib/school-resource-folders';

export type IndexedDocumentInput = {
  documentKey: string;
  sourceType: string;
  sourceRecordId: string;
  ownerId?: string | null;
  title: string;
  text: string;
  route?: string | null;
  board?: string | null;
  qualification?: string | null;
  level?: string | null;
  subjectCode?: string | null;
  topic?: string | null;
  year?: number | null;
  session?: string | null;
  paper?: string | null;
  documentType: string;
  visibility?: string;
  accessUserIds?: string[];
  extractionState?: 'extracting' | 'partial' | 'ready';
  metadata?: Prisma.InputJsonValue;
  extractedAt?: Date | null;
};

const OFFICIAL_SOURCE_TYPES = new Set(['question', 'markscheme', 'syllabus', 'resource']);

export async function refreshRagIndex(label: string, job: () => Promise<unknown>) {
  try {
    await job();
  } catch (error) {
    console.warn(`RAG index refresh failed for ${label}:`, error instanceof Error ? error.message : error);
  }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function plainText(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunksFor(text: string, size = 1100, overlap = 140) {
  const normalized = plainText(text);
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(size * 0.6)) end = boundary;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

export function academicMetadata(code?: string | null, name?: string | null, level?: string | null) {
  const haystack = `${code || ''} ${name || ''} ${level || ''}`.toLowerCase();
  if (/\bib\b|international baccalaureate|mathematics aa|mathematics ai/.test(haystack)) {
    return { board: 'IB', qualification: 'IB Diploma', level: level || null };
  }
  if (/^0\d{3}$/.test(code || '') || /igcse/.test(haystack)) {
    return { board: 'Cambridge', qualification: 'Cambridge IGCSE', level: level || 'IGCSE' };
  }
  if (/^9\d{3}$/.test(code || '') || /a[- ]?level|as level|cambridge international as/.test(haystack)) {
    return { board: 'Cambridge', qualification: 'Cambridge AS & A Level', level: level || 'AS & A Level' };
  }
  return { board: null, qualification: null, level: level || null };
}

export async function upsertIndexedDocument(input: IndexedDocumentInput) {
  const textChunks = chunksFor(input.text);
  if (textChunks.length === 0) {
    await prisma.ragDocument.deleteMany({ where: { documentKey: input.documentKey } });
    return null;
  }
  const contentHash = hash(textChunks.join('\n'));
  const now = new Date();

  // Prisma's interactive-transaction defaults (maxWait 2s, timeout 5s) are set
  // for a database on the same machine. This one is Neon, over the network, and
  // a bank question with many chunks spends most of its budget in the round
  // trips below. Reindexing the corpus at concurrency 8 failed 74 documents on
  // `timeout was 5000 ms, however 6633 ms passed`, then another 8 on "unable to
  // start a transaction in the given time" -- pool contention, not slow work.
  // Both numbers are ceilings, not waits: a fast transaction still returns fast.
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ragDocument.findUnique({ where: { documentKey: input.documentKey } });
    const data = {
      sourceType: input.sourceType,
      sourceRecordId: input.sourceRecordId,
      ownerId: input.ownerId ?? null,
      title: input.title,
      route: input.route ?? null,
      board: input.board ?? null,
      qualification: input.qualification ?? null,
      level: input.level ?? null,
      subjectCode: input.subjectCode ?? null,
      topic: input.topic ?? null,
      year: input.year ?? null,
      session: input.session ?? null,
      paper: input.paper ?? null,
      documentType: input.documentType,
      visibility: input.visibility ?? (input.ownerId ? 'private' : 'platform'),
      accessUserIds: [...new Set(input.accessUserIds ?? [])],
      contentHash,
      extractionState: input.extractionState ?? 'ready',
      metadata: input.metadata ?? {},
      extractedAt: input.extractedAt ?? null,
      indexedAt: now,
    };

    const document = existing
      ? await tx.ragDocument.update({ where: { id: existing.id }, data })
      : await tx.ragDocument.create({ data: { ...data, documentKey: input.documentKey } });

    if (!existing || existing.contentHash !== contentHash) {
      await tx.ragChunk.deleteMany({ where: { documentId: document.id } });
      await tx.ragChunk.createMany({
        data: textChunks.map((content, ordinal) => ({
          documentId: document.id,
          ordinal,
          content,
          contentHash: hash(content),
        })),
      });
    }
    return document;
  }, { maxWait: 15_000, timeout: 30_000 });
}

export async function indexNote(noteId: string) {
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    include: { course: { include: { curriculumScopes: true } }, collaborators: { select: { userId: true } } },
  });
  if (!note) return prisma.ragDocument.deleteMany({ where: { documentKey: `note:${noteId}` } });
  const scope = note.course?.curriculumScopes[0];
  const academic = scope ?? academicMetadata(null, note.course?.name, note.course?.level);
  return upsertIndexedDocument({
    documentKey: `note:${note.id}`,
    sourceType: 'note',
    sourceRecordId: note.id,
    ownerId: note.userId,
    title: note.title,
    text: note.content,
    route: `/?tab=notes&noteId=${note.id}`,
    ...academic,
    subjectCode: scope?.subjectCode,
    documentType: 'note',
    visibility: note.isPublic ? 'shared' : note.collaborators.length > 0 ? 'collaborator' : 'private',
    accessUserIds: note.collaborators.map((row) => row.userId),
    metadata: { tags: note.tags, courseId: note.courseId, crossCourse: note.courseId === null },
  });
}

export async function indexCloudDocument(documentId: string) {
  const document = await prisma.cloudDocument.findUnique({ where: { id: documentId } });
  // A `page:` clientId is `syncPageToCloud` mirroring a notebook Page for iPad
  // sync. The notebook was removed on 28 Sep 2026, so no new ones appear, but
  // existing mirrors are still in the table and were double-indexed against
  // the page's own document -- the skip stays.
  if (!document || document.deletedAt || document.clientId.startsWith('page:')) {
    return prisma.ragDocument.deleteMany({ where: { documentKey: `cloud-document:${documentId}` } });
  }
  return upsertIndexedDocument({
    documentKey: `cloud-document:${document.id}`,
    sourceType: 'cloud-note',
    sourceRecordId: document.id,
    ownerId: document.ownerId,
    title: document.title,
    text: document.body,
    route: '/?tab=notes-textbook',
    documentType: 'cloud-note',
    visibility: 'private',
    metadata: { clientId: document.clientId, format: document.format, revision: document.revision, crossCourse: true },
  });
}

export async function indexSchoolResource(resourceId: string) {
  const resource = await prisma.schoolResource.findUnique({ where: { id: resourceId } });
  if (!resource) return prisma.ragDocument.deleteMany({ where: { documentKey: `resource:${resourceId}` } });
  const academic = academicMetadata(null, resource.subject, null);
  const documentType = /syllabus|specification/i.test(`${resource.category} ${resource.title}`) ? 'syllabus' : 'resource';
  // What the file says, not just what it was called. Falls back to the old
  // description-and-filename text whenever the file has no readable layer.
  const extracted = await extractFileText(resource.fileUrl, resource.mimeType, resource.fileName);
  const folderPath = await folderPathFor(resource.folderId);
  const heading = `${resource.description}\n${resource.fileName}`;
  return upsertIndexedDocument({
    documentKey: `resource:${resource.id}`,
    sourceType: documentType === 'syllabus' ? 'syllabus' : 'resource',
    sourceRecordId: resource.id,
    title: folderPath ? `${resource.title} (${folderPath})` : resource.title,
    text: extracted.text ? `${heading}\n${extracted.text}` : heading,
    route: resource.fileUrl,
    ...academic,
    topic: resource.subject,
    documentType,
    visibility: 'platform',
    // `truncated` marks a document the chat can quote but must not be trusted
    // to have read to the end.
    extractionState: extracted.truncated ? 'partial' : 'ready',
    extractedAt: extracted.reason === 'ok' ? new Date() : null,
    metadata: {
      category: resource.category,
      mimeType: resource.mimeType,
      fileName: resource.fileName,
      folderPath,
      extraction: extracted.reason,
      ...(extracted.pages ? { pages: extracted.pages } : {}),
    },
  });
}

export async function indexAnnouncement(announcementId: string) {
  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId } });
  // An unpublished or expired announcement is withdrawn from search the same
  // way it's withdrawn from the notification/dashboard surfaces that read it.
  if (!announcement || !announcement.published || (announcement.expiresAt && announcement.expiresAt < new Date())) {
    return prisma.ragDocument.deleteMany({ where: { documentKey: `announcement:${announcementId}` } });
  }
  return upsertIndexedDocument({
    documentKey: `announcement:${announcement.id}`,
    sourceType: 'announcement',
    sourceRecordId: announcement.id,
    title: announcement.title,
    text: announcement.body,
    route: '/announcements',
    documentType: 'announcement',
    visibility: 'platform',
    metadata: { severity: announcement.severity, audience: announcement.audience, pinned: announcement.pinned },
  });
}

export async function indexDiscussionThread(threadId: string) {
  const thread = await prisma.discussionThread.findUnique({
    where: { id: threadId },
    include: {
      subject: { select: { name: true, code: true } },
      posts: { where: { hidden: false }, orderBy: { createdAt: 'asc' }, select: { content: true }, take: 50 },
    },
  });
  // A hidden thread (moderated) is withdrawn the same way a withdrawn bank
  // question is: a moderator's decision shouldn't still be citable by search.
  if (!thread || thread.hidden) {
    return prisma.ragDocument.deleteMany({ where: { documentKey: `discussion-thread:${threadId}` } });
  }
  const text = [thread.content, ...thread.posts.map((post) => post.content)].filter(Boolean).join('\n\n');
  return upsertIndexedDocument({
    documentKey: `discussion-thread:${thread.id}`,
    sourceType: 'discussion',
    sourceRecordId: thread.id,
    ownerId: thread.userId,
    title: thread.title,
    text,
    route: `/?tab=discussions&threadId=${thread.id}`,
    subjectCode: thread.subject?.code,
    topic: thread.category,
    documentType: 'discussion-thread',
    visibility: 'platform',
    metadata: { category: thread.category, subjectName: thread.subject?.name, postCount: thread.posts.length },
  });
}

/**
 * Past-paper catalogue metadata — the paper itself (subject, year, session,
 * paper number), not its questions (those are indexed per-question by
 * `indexPastPaperQuestion`). Lets a search for "0625 2023 paper 4" surface
 * the paper as a whole even before/without per-question transcription.
 */
export async function indexPastPaperCatalogue(paperId: number) {
  const paper = await prisma.pastPaper.findUnique({ where: { id: paperId }, include: { subject: true } });
  if (!paper) return prisma.ragDocument.deleteMany({ where: { documentKey: `past-paper:${paperId}` } });
  const academic = academicMetadata(paper.subject.code, paper.subject.name, paper.level || null);
  const label = paperLabel(paper.paperNumber, paper.variant);
  const kindLabel = paper.docType === 'ms' ? 'Mark Scheme' : paper.docType === 'qp' ? 'Question Paper' : paper.docType.toUpperCase();
  return upsertIndexedDocument({
    documentKey: `past-paper:${paper.id}`,
    sourceType: 'syllabus',
    sourceRecordId: String(paper.id),
    title: `${paper.subject.code} ${paper.subject.name} ${paper.year} ${paper.session.toUpperCase()} Paper ${label} ${kindLabel}`,
    text: `${paper.subject.name} ${paper.subject.code} ${paper.year} ${paper.session} paper ${label} ${kindLabel} ${paper.level} ${paper.timezone}`.trim(),
    route: `/?tab=papers&paperId=${paper.id}`,
    ...academic,
    subjectCode: paper.subject.code,
    year: paper.year,
    session: paper.session,
    paper: label,
    documentType: 'past-paper-catalogue',
    visibility: 'platform',
    metadata: { docType: paper.docType, pageCount: paper.pageCount, timezone: paper.timezone },
  });
}

function paperLabel(paperNumber: number, variant: number) {
  return variant > 0 ? `${paperNumber}${variant}` : `${paperNumber}`;
}

/**
 * Index one bank question, and its mark scheme as a second document.
 *
 * The bank is the corpus students actually practise on -- 66,756 published
 * questions against 12,398 past-paper ones -- and until now the chat could not
 * see a single one of them, because this file only ever read `pastPaperQuestion`.
 *
 * Two documents rather than one, mirroring `indexPastPaperQuestion`: a student
 * asking "how do I answer this" and one asking "what does the mark scheme want"
 * are different queries, and a single blob would return the answer to both.
 *
 * Both documents deep-link to the question via `?bqid=`, which
 * `app/components/routing.ts` resolves to the Practice tab with that question
 * open. This file used to write a bare `/bank` and said so, because when it was
 * written no page read a question id from the URL; `bqid` was added later and
 * the comment outlived the limitation. A citation landing at the top of a
 * 66,756-question bank is indistinguishable from a broken one.
 *
 * `lib/rag.ts`'s `indexedRoute` resolves the same link for the 88,209 documents
 * already written with `/bank`, which are not being backfilled -- an
 * 88,209-row UPDATE's WAL is what put the database in read-only on 25 Sep.
 */
export async function indexBankQuestion(questionId: number) {
  const keys = [`bank-question:${questionId}`, `bank-markscheme:${questionId}`];
  const question = await prisma.bankQuestion.findUnique({
    where: { id: questionId },
    include: { paper: { include: { subject: true } }, markScheme: true },
  });
  // An unpublished question is withdrawn from the index rather than downgraded:
  // `needs_review` means nobody has confirmed the transcription is right, and a
  // wrong transcription cited as fact is worse than no citation.
  if (!question || question.status !== 'published') {
    return prisma.ragDocument.deleteMany({ where: { documentKey: { in: keys } } });
  }

  // The bank is stored as page images with a screenshot per question, and its
  // transcription pass has never run at scale: 66,756 published questions carry
  // an empty bodyMd, and of 52,925 published mark schemes none has a marking
  // point or an answer longer than 40 characters -- the text that does exist is
  // the single letter of an MCQ key. Indexing that produced 19,441 documents
  // whose every chunk averaged one character: not retrievable, just corpus
  // noise that dilutes ranking and inflates the manifests.
  //
  // So a document is only worth making when there is a passage behind it. Until
  // transcription runs this yields nothing for the bank, which is the honest
  // outcome -- and the moment it does run, the same rule starts admitting them.
  const bodyText = question.bodyMd.trim();
  if (!isRetrievableText(bodyText)) {
    return prisma.ragDocument.deleteMany({ where: { documentKey: { in: keys } } });
  }

  const paper = question.paper;
  const subject = paper.subject;
  const academic = academicMetadata(subject.code, subject.name, subject.level);
  const label = paperLabel(paper.paperNumber, paper.variant);
  const stem = `${subject.code} ${paper.year} ${paper.session} Paper ${label} Q${question.rootNumber}`;
  const shared = {
    ...academic,
    subjectCode: subject.code,
    year: paper.year,
    session: paper.session,
    paper: label,
    visibility: 'platform',
    extractionState: (question.confidence >= 0.7 ? 'ready' : 'partial') as 'ready' | 'partial',
  };

  const document = await upsertIndexedDocument({
    ...shared,
    documentKey: keys[0],
    sourceType: 'question',
    sourceRecordId: String(question.id),
    title: stem,
    text: bodyText,
    route: `${BANK_QUESTION_ROUTE}${question.id}`,
    documentType: 'question-paper',
    metadata: {
      official: true,
      bank: true,
      paperId: paper.id,
      questionNumber: question.rootNumber,
      marks: question.totalMarks,
      difficulty: question.difficulty,
      timezone: paper.timezone,
    },
  });

  const markScheme = question.markScheme;
  const markSchemeBody = markScheme
    ? `${markScheme.answerMd}\n${markSchemeText(markScheme.markingPoints)}`.trim()
    : '';
  // Same rule as the question body. An MCQ key on its own is an answer, not a
  // passage: it belongs to the question's grading path, not to retrieval.
  if (!markScheme || markScheme.status !== 'published' || !isRetrievableText(markSchemeBody)) {
    await prisma.ragDocument.deleteMany({ where: { documentKey: keys[1] } });
    return document;
  }

  await upsertIndexedDocument({
    ...shared,
    documentKey: keys[1],
    sourceType: 'markscheme',
    sourceRecordId: String(markScheme.id),
    title: `${stem} mark scheme`,
    // The marking points carry what each mark is actually awarded for, which is
    // the part a student asking about a mark scheme wants.
    text: markSchemeBody,
    // The question's id, not `markScheme.id`: this document's `sourceRecordId`
    // is the mark scheme's, and `?bqid=` names a question.
    route: `${BANK_QUESTION_ROUTE}${question.id}`,
    documentType: 'mark-scheme',
    metadata: {
      official: true,
      bank: true,
      pairedSourceRecordId: String(question.id),
      answerLetter: markScheme.answerLetter,
      marks: markScheme.totalMarks,
    },
  });
  return document;
}

/**
 * The prose out of a `markingPoints` JSON array, ignoring anything that does
 * not parse. The column is free-form JSON, so a malformed row must degrade to
 * the plain answer rather than take the indexer down.
 */
function markSchemeText(markingPoints: string): string {
  try {
    const parsed: unknown = JSON.parse(markingPoints);
    if (!Array.isArray(parsed)) return '';
    return parsed
      .map((point) => {
        if (typeof point === 'string') return point;
        if (!point || typeof point !== 'object') return '';
        const row = point as Record<string, unknown>;
        const code = typeof row.mark_code === 'string' ? `${row.mark_code} ` : '';
        const text = typeof row.text === 'string' ? row.text : typeof row.description === 'string' ? row.description : '';
        return text ? `${code}${text}` : '';
      })
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

export async function indexCompetitionQuestion(questionId: number) {
  const question = await prisma.competitionQuestion.findUnique({ where: { id: questionId } });
  if (!question) return prisma.ragDocument.deleteMany({ where: { documentKey: `competition:${questionId}` } });
  return upsertIndexedDocument({
    documentKey: `competition:${question.id}`,
    sourceType: 'competition',
    sourceRecordId: String(question.id),
    title: question.title,
    text: question.body,
    route: `/?tab=competition&qid=${question.id}`,
    board: question.competition,
    qualification: 'Competition',
    level: 'Advanced',
    topic: question.labels.join(', '),
    year: Number.parseInt(question.yearLabel, 10) || null,
    paper: question.paper,
    documentType: 'competition-question',
    visibility: 'locked',
    metadata: { competition: question.competition, labels: question.labels, code: question.code },
  });
}

async function processIds<T>(ids: T[], worker: (id: T) => Promise<unknown>, concurrency = 12) {
  for (let offset = 0; offset < ids.length; offset += concurrency) {
    await Promise.all(ids.slice(offset, offset + concurrency).map(worker));
  }
}

export async function rebuildCorpusManifests() {
  const documents = await prisma.ragDocument.findMany({
    where: { sourceType: { in: [...OFFICIAL_SOURCE_TYPES] } },
    select: {
      board: true,
      qualification: true,
      level: true,
      subjectCode: true,
      year: true,
      paper: true,
      documentType: true,
      sourceType: true,
      extractionState: true,
      extractedAt: true,
      indexedAt: true,
      metadata: true,
    },
  });
  const groups = new Map<string, typeof documents>();
  for (const document of documents) {
    const base = [document.board || '', document.qualification || '', document.level || '', document.subjectCode || ''];
    for (const suffix of [[0, ''], [document.year || 0, document.documentType]] as const) {
      const key = [...base, suffix[0], suffix[1]].join('\u0000');
      const rows = groups.get(key) ?? [];
      rows.push(document);
      groups.set(key, rows);
    }
  }

  await prisma.ragCorpusManifest.deleteMany();
  for (const [key, rows] of groups) {
    const [board, qualification, level, subjectCode, yearText, documentType] = key.split('\u0000');
    const pairFailures = rows
      .filter((row) => row.sourceType === 'question')
      .filter((row) => !(row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) && row.metadata.paired === true))
      .length;
    const state = rows.some((row) => row.extractionState === 'extracting')
      ? 'extracting'
      : rows.some((row) => row.extractionState === 'partial') || pairFailures > 0
        ? 'partial'
        : 'ready';
    await prisma.ragCorpusManifest.create({
      data: {
        id: randomUUID(),
        board,
        qualification,
        level,
        subjectCode,
        year: Number(yearText),
        documentType,
        extractionState: state,
        questionCount: rows.filter((row) => row.sourceType === 'question').length,
        markSchemeCount: rows.filter((row) => row.sourceType === 'markscheme').length,
        resourceCount: rows.filter((row) => row.sourceType === 'resource' || row.sourceType === 'syllabus').length,
        availableYears: [...new Set(rows.map((row) => row.year).filter((year): year is number => year !== null))].sort(),
        availablePapers: [...new Set(rows.map((row) => row.paper).filter((paper): paper is string => Boolean(paper)))].sort(),
        lastExtractionAt: rows.map((row) => row.extractedAt).filter((date): date is Date => date !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
        lastIndexingAt: rows.map((row) => row.indexedAt).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
        failures: pairFailures > 0 ? [{ type: 'missing-pairing', count: pairFailures }] : [],
      },
    });
  }
  return { manifests: groups.size, documents: documents.length };
}

/**
 * Remove documents whose source record is gone.
 *
 * The per-record indexers delete on a missing row, but a full rebuild only ever
 * visits rows that still exist, so a deleted record's document was never
 * revisited and simply stayed. That is not theoretical: the index built on
 * 2026-07-23 carried 857 `resource:` documents after the underlying
 * `school_resources` rows had all gone -- 95% of the corpus pointing at records
 * that no longer existed, every one of them citable by the chat.
 *
 * Anything this run touched carries `indexedAt >= startedAt`, so what is older
 * is exactly what nothing re-indexed. Scoped to the prefixes the run actually
 * enumerated, so a partial rebuild cannot delete a family it never looked at.
 */
async function pruneStaleDocuments(startedAt: Date, prefixes: string[]) {
  if (prefixes.length === 0) return 0;
  const { count } = await prisma.ragDocument.deleteMany({
    where: {
      indexedAt: { lt: startedAt },
      OR: prefixes.map((prefix) => ({ documentKey: { startsWith: prefix } })),
    },
  });
  return count;
}

export async function reindexRagCorpus(options: { userId?: string; includeCompetition?: boolean } = {}) {
  const startedAt = new Date();
  const ownerFilter = options.userId ? { userId: options.userId } : undefined;
  const [notes, cloudDocuments, resources, bankQuestions, competition, announcements, discussionThreads, pastPapers] = await Promise.all([
    prisma.note.findMany({ where: ownerFilter, select: { id: true } }),
    prisma.cloudDocument.findMany({ where: options.userId ? { ownerId: options.userId } : undefined, select: { id: true } }),
    prisma.schoolResource.findMany({ select: { id: true } }),
    // Only published questions. `needs_review` transcriptions are excluded by
    // indexBankQuestion anyway; filtering here saves enumerating ~19k of them.
    options.userId ? Promise.resolve([]) : prisma.bankQuestion.findMany({ where: { status: 'published' }, select: { id: true } }),
    options.includeCompetition ? prisma.competitionQuestion.findMany({ select: { id: true } }) : Promise.resolve([]),
    // Announcements, discussions, and the paper catalogue are platform-wide,
    // not per-user, so a per-user rebuild skips them the same way it skips
    // the bank -- they'd just be indexed again, identically, on every call.
    options.userId ? Promise.resolve([]) : prisma.announcement.findMany({ where: { published: true }, select: { id: true } }),
    options.userId ? Promise.resolve([]) : prisma.discussionThread.findMany({ where: { hidden: false }, select: { id: true } }),
    options.userId ? Promise.resolve([]) : prisma.pastPaper.findMany({ select: { id: true } }),
  ]);
  await processIds(notes.map((row) => row.id), indexNote);
  await processIds(cloudDocuments.map((row) => row.id), indexCloudDocument);
  await processIds(resources.map((row) => row.id), indexSchoolResource);
  await processIds(bankQuestions.map((row) => row.id), indexBankQuestion);
  await processIds(competition.map((row) => row.id), indexCompetitionQuestion);
  await processIds(announcements.map((row) => row.id), indexAnnouncement);
  await processIds(discussionThreads.map((row) => row.id), indexDiscussionThread);
  await processIds(pastPapers.map((row) => row.id), indexPastPaperCatalogue);

  // A per-user rebuild sees only that user's rows, so everyone else's documents
  // would look stale to it. Pruning belongs to the full rebuild alone.
  //
  // 'shared-note:', 'page:' and 'past-paper-question:' stay in this list even
  // though nothing indexes them anymore -- the community shared-notes feature,
  // the notebook, and on 29 Sep 2026 the legacy question documents were all
  // removed. Keeping the prefixes is what gets their leftover documents pruned
  // by the next full rebuild; dropping them would strand those documents in
  // the index permanently.
  //
  // Why the legacy question documents went: their route was
  // `/?tab=questions-db&qid=`, which opens the old text-corpus browser. The id
  // in it belongs to that corpus and means nothing to the crop-first bank, so
  // such a citation could not be repointed at the bank -- only stopped from
  // being made. Indexing them meant a search result or an AI citation dropped a
  // student into a browser the platform no longer practises on. The paper
  // *catalogue* ('past-paper:') is untouched: it routes to /papers/[id], which
  // is a live surface.
  const prefixes = options.userId
    ? []
    : [
        'note:',
        'shared-note:',
        'page:',
        'cloud-document:',
        'resource:',
        'past-paper-question:',
        'bank-question:',
        'bank-markscheme:',
        'announcement:',
        'discussion-thread:',
        'past-paper:',
        ...(options.includeCompetition ? ['competition:'] : []),
      ];
  const pruned = await pruneStaleDocuments(startedAt, prefixes);

  const manifests = await rebuildCorpusManifests();
  return {
    indexed:
      notes.length + cloudDocuments.length + resources.length +
      bankQuestions.length + competition.length +
      announcements.length + discussionThreads.length + pastPapers.length,
    pruned,
    ...manifests,
  };
}
