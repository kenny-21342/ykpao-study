import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { extractFileText } from '@/lib/rag-file-text';

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
  });
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

export async function indexSharedNote(sharedNoteId: string) {
  const note = await prisma.sharedNote.findUnique({ where: { id: sharedNoteId } });
  if (!note) return prisma.ragDocument.deleteMany({ where: { documentKey: `shared-note:${sharedNoteId}` } });
  const course = note.courseCode
    ? await prisma.course.findUnique({ where: { code: note.courseCode }, include: { curriculumScopes: true } })
    : null;
  const scope = course?.curriculumScopes[0];
  const academic = scope ?? academicMetadata(/^[0-9]{4}$/.test(note.courseCode ?? '') ? note.courseCode : null, note.subject, null);
  return upsertIndexedDocument({
    documentKey: `shared-note:${note.id}`,
    sourceType: 'note',
    sourceRecordId: note.id,
    ownerId: note.userId,
    title: note.title,
    text: note.content,
    route: `/shared-notes/${note.id}`,
    ...academic,
    subjectCode: scope?.subjectCode ?? (/^[0-9]{4}$/.test(note.courseCode ?? '') ? note.courseCode : null),
    documentType: 'note',
    visibility: note.visibility === 'public' ? 'shared' : 'private',
    metadata: { tags: note.tags, shared: true, courseId: course?.id ?? null, crossCourse: !course },
  });
}

export async function indexPage(pageId: string) {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    include: {
      collaborators: { select: { userId: true } },
      section: { include: { notebook: { include: { course: { include: { curriculumScopes: true } } } } } },
    },
  });
  if (!page) return prisma.ragDocument.deleteMany({ where: { documentKey: `page:${pageId}` } });
  const notebook = page.section.notebook;
  const scope = notebook.course?.curriculumScopes[0];
  const academic = scope ?? academicMetadata(null, notebook.course?.name, notebook.course?.level);
  return upsertIndexedDocument({
    documentKey: `page:${page.id}`,
    sourceType: 'textbook',
    sourceRecordId: page.id,
    ownerId: notebook.userId,
    title: `${notebook.name}: ${page.title}`,
    text: page.content,
    route: `/?tab=notes-textbook&pageId=${page.id}`,
    ...academic,
    subjectCode: scope?.subjectCode,
    documentType: 'notebook-page',
    visibility: page.collaborators.length > 0 ? 'collaborator' : 'private',
    accessUserIds: page.collaborators.map((row) => row.userId),
    metadata: { tags: page.tags, notebookId: notebook.id, sectionId: page.sectionId, courseId: notebook.courseId, crossCourse: notebook.courseId === null },
  });
}

export async function indexCloudDocument(documentId: string) {
  const document = await prisma.cloudDocument.findUnique({ where: { id: documentId } });
  // A `page:` clientId is `syncPageToCloud` mirroring a Page for iPad sync, and
  // `indexPage` has already indexed that same text. Indexing the mirror too put
  // every notebook page into the corpus twice -- one copy per key -- which the
  // incremental path avoided only because nothing ever called this function.
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
  const heading = `${resource.description}\n${resource.fileName}`;
  return upsertIndexedDocument({
    documentKey: `resource:${resource.id}`,
    sourceType: documentType === 'syllabus' ? 'syllabus' : 'resource',
    sourceRecordId: resource.id,
    title: resource.title,
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
      extraction: extracted.reason,
      ...(extracted.pages ? { pages: extracted.pages } : {}),
    },
  });
}

function paperLabel(paperNumber: number, variant: number) {
  return variant > 0 ? `${paperNumber}${variant}` : `${paperNumber}`;
}

export async function indexPastPaperQuestion(questionId: number) {
  const question = await prisma.pastPaperQuestion.findUnique({
    where: { id: questionId },
    include: { paper: { include: { subject: true } } },
  });
  if (!question) return prisma.ragDocument.deleteMany({ where: { documentKey: `past-paper-question:${questionId}` } });
  const paper = question.paper;
  const academic = academicMetadata(paper.subject.code, paper.subject.name, null);
  const pairPaper = await prisma.pastPaper.findFirst({
    where: {
      subjectId: paper.subjectId,
      year: paper.year,
      session: paper.session,
      paperNumber: paper.paperNumber,
      variant: paper.variant,
      docType: question.docType === 'ms' ? 'qp' : 'ms',
    },
    select: { id: true },
  });
  const paired = pairPaper
    ? await prisma.pastPaperQuestion.findFirst({
        where: {
          paperId: pairPaper.id,
          number: question.number,
          part: question.part,
          subPart: question.subPart,
          docType: question.docType === 'ms' ? 'qp' : 'ms',
        },
        select: { id: true },
      })
    : null;
  const referenceQuestionId = question.docType === 'qp' ? question.id : paired?.id;
  const pairKey = [paper.subject.code, paper.year, paper.session, paper.paperNumber, paper.variant, question.number, question.part, question.subPart].join(':');
  const kind = question.docType === 'ms' ? 'markscheme' : 'question';
  return upsertIndexedDocument({
    documentKey: `past-paper-question:${question.id}`,
    sourceType: kind,
    sourceRecordId: String(question.id),
    title: `${paper.subject.code} ${paper.year} ${paper.session} Paper ${paperLabel(paper.paperNumber, paper.variant)} Q${question.number}${question.part}${question.subPart}${kind === 'markscheme' ? ' mark scheme' : ''}`,
    text: `${question.content}\n${question.latex}`,
    route: referenceQuestionId ? `/?tab=questions-db&qid=${referenceQuestionId}` : '/?tab=questions-db',
    ...academic,
    subjectCode: paper.subject.code,
    topic: question.topic,
    year: paper.year,
    session: paper.session,
    paper: paperLabel(paper.paperNumber, paper.variant),
    documentType: kind === 'markscheme' ? 'mark-scheme' : 'question-paper',
    visibility: 'platform',
    extractionState: paper.processedAt ? 'ready' : 'partial',
    extractedAt: paper.processedAt ? new Date(paper.processedAt) : null,
    metadata: {
      pairKey,
      pairedSourceRecordId: paired ? String(paired.id) : null,
      questionNumber: question.number,
      part: question.part,
      subPart: question.subPart,
      marks: question.marks,
      official: true,
      paperId: paper.id,
      paired: Boolean(paired),
    },
  });
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
 * There is no per-question route to link to -- no page reads a question id from
 * the URL -- so citations point at the bank surface and carry the paper and
 * question number in the title.
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
    text: question.bodyMd,
    route: '/bank',
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
  if (!markScheme || markScheme.status !== 'published') {
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
    text: `${markScheme.answerMd}\n${markSchemeText(markScheme.markingPoints)}`,
    route: '/bank',
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
  const [notes, sharedNotes, pages, cloudDocuments, resources, questions, bankQuestions, competition] = await Promise.all([
    prisma.note.findMany({ where: ownerFilter, select: { id: true } }),
    prisma.sharedNote.findMany({ where: options.userId ? { userId: options.userId } : undefined, select: { id: true } }),
    prisma.page.findMany({
      where: options.userId ? { section: { notebook: { userId: options.userId } } } : undefined,
      select: { id: true },
    }),
    prisma.cloudDocument.findMany({ where: options.userId ? { ownerId: options.userId } : undefined, select: { id: true } }),
    prisma.schoolResource.findMany({ select: { id: true } }),
    prisma.pastPaperQuestion.findMany({ select: { id: true } }),
    // Only published questions. `needs_review` transcriptions are excluded by
    // indexBankQuestion anyway; filtering here saves enumerating ~19k of them.
    options.userId ? Promise.resolve([]) : prisma.bankQuestion.findMany({ where: { status: 'published' }, select: { id: true } }),
    options.includeCompetition ? prisma.competitionQuestion.findMany({ select: { id: true } }) : Promise.resolve([]),
  ]);
  await processIds(notes.map((row) => row.id), indexNote);
  await processIds(sharedNotes.map((row) => row.id), indexSharedNote);
  await processIds(pages.map((row) => row.id), indexPage);
  await processIds(cloudDocuments.map((row) => row.id), indexCloudDocument);
  await processIds(resources.map((row) => row.id), indexSchoolResource);
  await processIds(questions.map((row) => row.id), indexPastPaperQuestion);
  await processIds(bankQuestions.map((row) => row.id), indexBankQuestion);
  await processIds(competition.map((row) => row.id), indexCompetitionQuestion);

  // A per-user rebuild sees only that user's rows, so everyone else's documents
  // would look stale to it. Pruning belongs to the full rebuild alone.
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
        ...(options.includeCompetition ? ['competition:'] : []),
      ];
  const pruned = await pruneStaleDocuments(startedAt, prefixes);

  const manifests = await rebuildCorpusManifests();
  return {
    indexed:
      notes.length + sharedNotes.length + pages.length + cloudDocuments.length + resources.length +
      questions.length + bankQuestions.length + competition.length,
    pruned,
    ...manifests,
  };
}
