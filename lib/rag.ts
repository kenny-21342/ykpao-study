import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { corpusCoverageForIntent, planCopilotQuery } from '@/lib/copilot-query';
import type { CopilotIntent, CorpusCoverage } from '@/lib/copilot-types';

/**
 * RAG (Retrieval-Augmented Generation) context builder.
 *
 * Given a student's question, retrieves the most relevant passages from:
 *   1. Textbook pages (uploaded textbook content stored in the Page model)
 *   2. User + public notes (the Note model)
 *   3. Past paper questions + mark schemes (PastPaperQuestion)
 *
 * Uses Postgres full-text search (tsvector/tsquery) — no vector DB needed.
 * Each source returns text chunks ranked by relevance, which are then fed
 * as context to the LLM.
 */

export type RAGSource = {
  type: 'textbook' | 'note' | 'question' | 'markscheme' | 'resource' | 'syllabus' | 'competition' | 'generated';
  title: string;
  content: string; // truncated to maxCharsPerSource
  url?: string;
  relevance: number; // 0-1 ranking score
  authority?: 'official' | 'personal' | 'school' | 'competition' | 'generated' | 'provisional';
  sourceRecordId?: string;
  pairSourceRecordId?: string;
  citation?: string;
};

export type RAGResult = {
  sources: RAGSource[];
  context: string; // pre-formatted context string for the LLM prompt
  totalFound: number;
  intent: CopilotIntent;
  corpusCoverage: CorpusCoverage;
  queryExpansion?: string;
  filters?: Record<string, unknown>;
};

type CurriculumScope = { board: string; qualification: string; level: string; subjectCode: string };

const MAX_SOURCES = 8;
const MAX_CHARS_PER_SOURCE = 1200;
const MAX_CONTEXT_CHARS = 8000;

/**
 * Search across all knowledge sources for content relevant to the query.
 * Returns ranked sources + a pre-formatted context string.
 */
export async function retrieveContext(
  query: string,
  options: {
    userId?: string;
    subjectCode?: string;
    level?: string;
    includeCompetition?: boolean;
    maxSources?: number;
    courseId?: string;
    curriculumScopes?: CurriculumScope[];
    strictCourseScope?: boolean;
    priorityTopics?: string[];
  } = {}
): Promise<RAGResult> {
  const maxSources = options.maxSources ?? MAX_SOURCES;
  const sanitized = sanitizeQuery(query);
  const plannedIntent = await planCopilotQuery(sanitized || query, { subjectCode: options.subjectCode, level: options.level });
  const primaryScope = options.curriculumScopes?.[0];
  const intent = primaryScope ? {
    ...plannedIntent,
    board: primaryScope.board,
    qualification: primaryScope.qualification,
    level: primaryScope.level,
    subjectCode: options.curriculumScopes?.length === 1 ? primaryScope.subjectCode : undefined,
  } : plannedIntent;
  const corpusCoverage = await corpusCoverageForIntent(intent, options.userId || '');
  if (!sanitized) {
    return { sources: [], context: '', totalFound: 0, intent, corpusCoverage };
  }

  const indexed = await retrieveIndexedContext(sanitized, intent, {
    userId: options.userId,
    includeCompetition: options.includeCompetition,
    maxSources,
    courseId: options.courseId,
    curriculumScopes: options.curriculumScopes,
    strictCourseScope: options.strictCourseScope,
    priorityTopics: options.priorityTopics,
  });
  if (indexed.sources.length > 0) {
    return { ...indexed, intent, corpusCoverage };
  }

  // Never let the compatibility search mix official material across a
  // requested board, qualification, level, or subject. During rollout a slice
  // may be indexed but empty while its personal materials are still useful.
  const hasStrongMetadata = Boolean(intent.board || intent.qualification || intent.level || intent.subjectCode || intent.subject);
  if (hasStrongMetadata) {
    const [notes, textbookPages, cloudDocuments] = await Promise.all([
      searchNotes(sanitized, options.userId, options.courseId, options.strictCourseScope),
      searchTextbookPages(sanitized, options.userId, options.courseId, options.strictCourseScope),
      searchCloudDocuments(sanitized, options.userId, options.strictCourseScope),
    ]);
    const personal = [...notes, ...textbookPages, ...cloudDocuments].slice(0, maxSources);
    return {
      sources: personal,
      context: formatContext(personal),
      totalFound: personal.length,
      intent,
      corpusCoverage,
    };
  }

  // Run searches in parallel across all sources.
  const [notes, textbookPages, cloudDocuments, questions, markschemes, resources] = await Promise.all([
    searchNotes(sanitized, options.userId, options.courseId, options.strictCourseScope),
    searchTextbookPages(sanitized, options.userId, options.courseId, options.strictCourseScope),
    searchCloudDocuments(sanitized, options.userId, options.strictCourseScope),
    searchQuestions(sanitized, options.curriculumScopes?.map((scope) => scope.subjectCode) ?? (options.subjectCode ? [options.subjectCode] : undefined)),
    searchMarkschemes(sanitized, options.curriculumScopes?.map((scope) => scope.subjectCode) ?? (options.subjectCode ? [options.subjectCode] : undefined)),
    searchResources(sanitized),
  ]);

  // Merge, re-rank by relevance, and take top N.
  const all = [...notes, ...textbookPages, ...cloudDocuments, ...questions, ...markschemes, ...resources]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxSources);

  // Build the context string for the LLM.
  const context = formatContext(all);

  return {
    sources: all,
    context,
    totalFound: notes.length + textbookPages.length + cloudDocuments.length + questions.length + markschemes.length + resources.length,
    intent,
    corpusCoverage,
  };
}

type IndexedRow = {
  documentId: string;
  sourceType: string;
  sourceRecordId: string;
  title: string;
  route: string | null;
  content: string;
  metadata: Prisma.JsonValue;
  rank: number;
};

function sourceType(type: string): RAGSource['type'] {
  if (type === 'cloud-note' || type === 'note') return 'note';
  if (type === 'textbook') return 'textbook';
  if (type === 'markscheme') return 'markscheme';
  if (type === 'question') return 'question';
  if (type === 'syllabus') return 'syllabus';
  if (type === 'competition') return 'competition';
  return 'resource';
}

function sourceAuthority(type: string): NonNullable<RAGSource['authority']> {
  if (type === 'question' || type === 'markscheme' || type === 'syllabus') return 'official';
  if (type === 'note' || type === 'cloud-note' || type === 'textbook') return 'personal';
  if (type === 'competition') return 'competition';
  return 'school';
}

function metadataValue(metadata: Prisma.JsonValue, key: string) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata[key] : undefined;
}

async function retrieveIndexedContext(
  query: string,
  intent: CopilotIntent,
  options: {
    userId?: string;
    includeCompetition?: boolean;
    maxSources: number;
    courseId?: string;
    curriculumScopes?: CurriculumScope[];
    strictCourseScope?: boolean;
    priorityTopics?: string[];
  },
): Promise<Pick<RAGResult, 'sources' | 'context' | 'totalFound'>> {
  if (!options.userId) return { sources: [], context: '', totalFound: 0 };
  try {
    const terms = searchTerms(query);
    const tsQuery = terms.map((term) => `${term.replace(/[^a-z0-9-]/gi, '')}:*`).filter((term) => term !== ':*').join(' | ');
    if (!tsQuery) return { sources: [], context: '', totalFound: 0 };
    const filters: Prisma.Sql[] = [
      Prisma.sql`(
        d."visibility" IN ('platform', 'shared')
        OR d."ownerId" = ${options.userId}
        OR d."accessUserIds" @> ARRAY[${options.userId}]::TEXT[]
        OR (${Boolean(options.includeCompetition)} AND d."visibility" = 'locked' AND d."sourceType" = 'competition')
      )`,
      Prisma.sql`(d."visibility" <> 'locked' OR ${Boolean(options.includeCompetition)})`,
    ];
    if (options.strictCourseScope) {
      const scopeClauses = (options.curriculumScopes ?? []).map((scope) => Prisma.sql`(
        lower(coalesce(d."board", '')) = lower(${scope.board})
        AND lower(coalesce(d."qualification", '')) = lower(${scope.qualification})
        AND lower(coalesce(d."level", '')) LIKE ${`%${scope.level.toLowerCase()}%`}
        AND lower(coalesce(d."subjectCode", '')) = lower(${scope.subjectCode})
      )`);
      const officialScope = scopeClauses.length > 0 ? Prisma.sql`(${Prisma.join(scopeClauses, ' OR ')})` : Prisma.sql`FALSE`;
      filters.push(Prisma.sql`(
        (d."sourceType" IN ('note', 'cloud-note', 'textbook') AND (
          d."metadata"->>'courseId' = ${options.courseId ?? ''}
          OR d."metadata"->>'crossCourse' = 'true'
        ))
        OR (d."sourceType" NOT IN ('note', 'cloud-note', 'textbook') AND ${officialScope})
      )`);
    } else {
      if (intent.board) filters.push(Prisma.sql`lower(coalesce(d."board", '')) = lower(${intent.board})`);
      if (intent.qualification) filters.push(Prisma.sql`lower(coalesce(d."qualification", '')) = lower(${intent.qualification})`);
      if (intent.level) filters.push(Prisma.sql`lower(coalesce(d."level", '')) LIKE ${`%${intent.level.toLowerCase()}%`}`);
    }
    if (intent.year) filters.push(Prisma.sql`d."year" = ${intent.year}`);
    if (intent.session) filters.push(Prisma.sql`lower(coalesce(d."session", '')) LIKE ${`%${intent.session.toLowerCase()}%`}`);
    if (intent.paper) filters.push(Prisma.sql`lower(coalesce(d."paper", '')) = lower(${intent.paper})`);
    if (!options.strictCourseScope && intent.subjectCode) {
      filters.push(Prisma.sql`lower(coalesce(d."subjectCode", '')) = lower(${intent.subjectCode})`);
    } else if (!options.strictCourseScope && intent.subject) {
      const subjects = await prisma.subject.findMany({
        where: { name: { contains: intent.subject, mode: 'insensitive' } },
        select: { code: true },
        take: 20,
      });
      if (subjects.length > 0) filters.push(Prisma.sql`d."subjectCode" IN (${Prisma.join(subjects.map((subject) => subject.code))})`);
    }
    if (intent.topic) filters.push(Prisma.sql`(lower(coalesce(d."topic", '')) LIKE ${`%${intent.topic.toLowerCase()}%`} OR lower(d."title") LIKE ${`%${intent.topic.toLowerCase()}%`})`);

    const personalTypes = ['note', 'cloud-note', 'textbook'];
    const officialTypes = ['question', 'markscheme', 'syllabus'];
    if (intent.provider === 'competition') filters.push(Prisma.sql`d."sourceType" = 'competition'`);
    else if (intent.provider === 'official' || intent.name === 'assessment') filters.push(Prisma.sql`d."sourceType" IN (${Prisma.join(officialTypes)})`);
    else if (intent.name === 'review') filters.push(Prisma.sql`d."sourceType" IN (${Prisma.join([...officialTypes, ...personalTypes])})`);

    const priorityTopics = [...new Set((options.priorityTopics ?? []).map((topic) => topic.toLowerCase()).filter(Boolean))];
    const masteryBoost = priorityTopics.length > 0
      ? Prisma.sql`CASE WHEN lower(coalesce(d."topic", '')) IN (${Prisma.join(priorityTopics)}) THEN 0.12 ELSE 0 END`
      : Prisma.sql`0`;
    const rows = await prisma.$queryRaw<IndexedRow[]>(Prisma.sql`
      SELECT
        d."id" AS "documentId",
        d."sourceType",
        d."sourceRecordId",
        d."title",
        d."route",
        c."content",
        d."metadata",
        (
          ts_rank_cd(c."searchVector", to_tsquery('english', ${tsQuery}))
          + similarity(d."title", ${query}) * 0.35
          + ${masteryBoost}
          + CASE
              WHEN ${intent.name} IN ('assessment', 'practice') AND d."sourceType" IN ('question', 'markscheme', 'syllabus') THEN 0.25
              WHEN ${intent.name} = 'explanation' AND d."sourceType" IN ('note', 'cloud-note', 'textbook') THEN 0.20
              ELSE 0
            END
        )::double precision AS "rank"
      FROM "rag_chunks" c
      JOIN "rag_documents" d ON d."id" = c."documentId"
      WHERE (${Prisma.join(filters, ' AND ')})
        AND (
          c."searchVector" @@ to_tsquery('english', ${tsQuery})
          OR similarity(c."content", ${query}) > 0.045
          OR similarity(d."title", ${query}) > 0.08
        )
      ORDER BY "rank" DESC, d."indexedAt" DESC
      LIMIT 60
    `);

    const byDocument = new Map<string, IndexedRow>();
    for (const row of rows) if (!byDocument.has(row.documentId)) byDocument.set(row.documentId, row);
    const ranked = [...byDocument.values()].sort((a, b) => b.rank - a.rank);
    const selected: IndexedRow[] = [];
    const perType = new Map<string, number>();
    for (const row of ranked) {
      const count = perType.get(row.sourceType) ?? 0;
      if (count >= 3) continue;
      selected.push(row);
      perType.set(row.sourceType, count + 1);
      if (selected.length >= options.maxSources) break;
    }

    for (const question of [...selected]) {
      if (question.sourceType !== 'question' || selected.length >= options.maxSources) continue;
      const pairId = metadataValue(question.metadata, 'pairedSourceRecordId');
      if (typeof pairId !== 'string' || selected.some((row) => row.sourceRecordId === pairId)) continue;
      const pairScopes = options.curriculumScopes ?? [];
      if (options.strictCourseScope && pairScopes.length === 0) continue;
      const pair = await prisma.ragDocument.findFirst({
        where: {
          sourceType: 'markscheme',
          sourceRecordId: pairId,
          visibility: 'platform',
          ...(options.strictCourseScope ? {
            OR: pairScopes.map((scope) => ({
              board: { equals: scope.board, mode: 'insensitive' as const },
              qualification: { equals: scope.qualification, mode: 'insensitive' as const },
              level: { contains: scope.level, mode: 'insensitive' as const },
              subjectCode: { equals: scope.subjectCode, mode: 'insensitive' as const },
            })),
          } : {}),
        },
        include: { chunks: { orderBy: { ordinal: 'asc' }, take: 1 } },
      });
      if (pair?.chunks[0]) {
        selected.push({
          documentId: pair.id,
          sourceType: pair.sourceType,
          sourceRecordId: pair.sourceRecordId,
          title: pair.title,
          route: pair.route,
          content: pair.chunks[0].content,
          metadata: pair.metadata,
          rank: Math.max(0, question.rank - 0.01),
        });
      }
    }

    const maximum = Math.max(...selected.map((row) => row.rank), 1);
    const sources: RAGSource[] = selected.map((row, index) => ({
      type: sourceType(row.sourceType),
      title: row.title,
      content: truncate(row.content, MAX_CHARS_PER_SOURCE),
      url: row.route ?? undefined,
      relevance: Math.max(0.05, Math.min(1, row.rank / maximum)),
      authority: sourceAuthority(row.sourceType),
      sourceRecordId: row.sourceRecordId,
      pairSourceRecordId: typeof metadataValue(row.metadata, 'pairedSourceRecordId') === 'string' ? metadataValue(row.metadata, 'pairedSourceRecordId') as string : undefined,
      citation: `S${index + 1}`,
    }));
    return { sources, context: formatContext(sources), totalFound: rows.length };
  } catch (error) {
    console.warn('Normalized RAG index is unavailable; using legacy retrieval.', error instanceof Error ? error.message : error);
    return { sources: [], context: '', totalFound: 0 };
  }
}

// ---------------------------------------------------------------------------
// Individual source searchers
// ---------------------------------------------------------------------------

async function searchNotes(query: string, userId?: string, courseId?: string, strictCourseScope?: boolean): Promise<RAGSource[]> {
  if (!userId) return [];
  try {
    // Use Postgres ILIKE for simplicity (works without FTS indexes).
    // For larger scale, add a tsvector column + GIN index.
    const terms = searchTerms(query);
    const notes = await prisma.note.findMany({
      where: {
        AND: [
          {
            OR: [
              { userId },
              { isPublic: true },
            ],
          },
          ...(strictCourseScope ? [{ OR: [{ courseId }, { courseId: null }] }] : []),
          {
            OR: terms.flatMap((term) => [
              { title: { contains: term, mode: 'insensitive' as const } },
              { content: { contains: term, mode: 'insensitive' as const } },
              { tags: { hasSome: [term] } },
            ]),
          },
        ],
      },
      select: { title: true, content: true, id: true },
      take: 5,
    });

    return notes.map((n) => ({
      type: 'note' as const,
      title: n.title,
      content: truncate(n.content, MAX_CHARS_PER_SOURCE),
      url: `/notes/${n.id}`,
      relevance: 0.7, // ILIKE match — no precise rank, so give a fixed score
    }));
  } catch {
    return [];
  }
}

async function searchTextbookPages(query: string, userId?: string, courseId?: string, strictCourseScope?: boolean): Promise<RAGSource[]> {
  if (!userId) return [];
  try {
    const terms = searchTerms(query);
    const pages = await prisma.page.findMany({
      where: {
        AND: [
          { OR: [{ section: { notebook: { userId } } }, { collaborators: { some: { userId } } }] },
          ...(strictCourseScope ? [{ OR: [{ section: { notebook: { courseId } } }, { section: { notebook: { courseId: null } } }] }] : []),
          { OR: terms.flatMap((term) => [
            { title: { contains: term, mode: 'insensitive' as const } },
            { content: { contains: term, mode: 'insensitive' as const } },
            { tags: { has: term } },
          ]) },
        ],
      },
      include: { section: { include: { notebook: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    });
    return pages.map((page) => ({
      type: 'textbook' as const,
      title: `${page.section.notebook.name}: ${page.title}`,
      content: truncate(page.content, MAX_CHARS_PER_SOURCE),
      url: '/?tab=notes-textbook',
      relevance: 0.75,
    }));
  } catch {
    return [];
  }
}

async function searchCloudDocuments(query: string, userId?: string, strictCourseScope?: boolean): Promise<RAGSource[]> {
  if (!userId) return [];
  if (strictCourseScope) return [];
  try {
    const terms = searchTerms(query);
    const documents = await prisma.cloudDocument.findMany({
      where: {
        ownerId: userId,
        deletedAt: null,
        NOT: { clientId: { startsWith: 'page:' } },
        OR: terms.flatMap((term) => [
          { title: { contains: term, mode: 'insensitive' as const } },
          { body: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      orderBy: { updatedAt: 'desc' },
      take: 4,
    });
    return documents.map((document) => ({
      type: 'note' as const,
      title: document.title,
      content: truncate(document.body, MAX_CHARS_PER_SOURCE),
      url: '/?tab=notes-textbook',
      relevance: 0.72,
    }));
  } catch {
    return [];
  }
}

async function searchQuestions(query: string, subjectCodes?: string[]): Promise<RAGSource[]> {
  try {
    const terms = searchTerms(query);
    const where: Record<string, unknown> = {
      docType: 'qp',
      OR: terms.flatMap((term) => [
        { content: { contains: term, mode: 'insensitive' } },
        { topic: { contains: term, mode: 'insensitive' } },
      ]),
    };
    if (subjectCodes) {
      where.paper = { subject: { code: { in: subjectCodes } } };
    }

    const questions = await prisma.pastPaperQuestion.findMany({
      where,
      select: {
        id: true,
        content: true,
        topic: true,
        number: true,
        part: true,
        marks: true,
        paper: {
          select: {
            subject: { select: { name: true, code: true } },
            year: true,
            session: true,
          },
        },
      },
      take: 5,
    });

    return questions.map((q) => ({
      type: 'question' as const,
      title: `${q.paper.subject.code} Q${q.number}${q.part} (${q.paper.year} ${q.paper.session}) — ${q.topic}`,
      content: truncate(q.content, MAX_CHARS_PER_SOURCE),
      url: `/?tab=questions-db&qid=${q.id}`,
      relevance: 0.6,
    }));
  } catch {
    return [];
  }
}

async function searchMarkschemes(query: string, subjectCodes?: string[]): Promise<RAGSource[]> {
  try {
    const terms = searchTerms(query);
    const where: Record<string, unknown> = {
      docType: 'ms',
      OR: terms.map((term) => ({ content: { contains: term, mode: 'insensitive' } })),
    };
    if (subjectCodes) {
      where.paper = { subject: { code: { in: subjectCodes } } };
    }

    const schemes = await prisma.pastPaperQuestion.findMany({
      where,
      select: {
        content: true,
        topic: true,
        number: true,
        paper: {
          select: {
            subject: { select: { name: true, code: true } },
            year: true,
          },
        },
      },
      take: 3,
    });

    return schemes.map((ms) => ({
      type: 'markscheme' as const,
      title: `${ms.paper.subject.code} Mark Scheme Q${ms.number} (${ms.paper.year}) — ${ms.topic}`,
      content: truncate(ms.content, MAX_CHARS_PER_SOURCE),
      relevance: 0.5,
    }));
  } catch {
    return [];
  }
}

async function searchResources(query: string): Promise<RAGSource[]> {
  try {
    const terms = searchTerms(query);
    const resources = await prisma.schoolResource.findMany({
      where: {
        OR: terms.flatMap((term) => [
          { title: { contains: term, mode: 'insensitive' as const } },
          { description: { contains: term, mode: 'insensitive' as const } },
          { subject: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      take: 4,
      orderBy: { createdAt: 'desc' },
    });
    return resources.map((resource) => ({
      type: 'resource' as const,
      title: resource.title,
      content: truncate(resource.description || resource.fileName, MAX_CHARS_PER_SOURCE),
      url: resource.fileUrl,
      relevance: 0.45,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeQuery(q: string): string {
  // Remove special chars that could break ILIKE or be SQL-injection vectors.
  // Prisma's parameterized queries handle injection, but wildcards need escaping.
  return q
    .replace(/[%_\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function searchTerms(query: string) {
  const stopWords = new Set(['about', 'after', 'again', 'could', 'explain', 'from', 'have', 'help', 'into', 'please', 'that', 'their', 'there', 'these', 'this', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9-]/g, ''))
    .filter((term) => term.length >= 3 && !stopWords.has(term));
  return [...new Set(terms)].slice(0, 6).length > 0 ? [...new Set(terms)].slice(0, 6) : [query];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Truncate at a word boundary.
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return cut.slice(0, lastSpace > 0 ? lastSpace : max) + '…';
}

function formatContext(sources: RAGSource[]): string {
  if (sources.length === 0) return '';
  let total = 0;
  const parts: string[] = [];
  for (const [index, src] of sources.entries()) {
    if (total + src.content.length > MAX_CONTEXT_CHARS) break;
    const label =
      src.type === 'textbook' ? '📖 Textbook' :
      src.type === 'note' ? '📝 Note' :
      src.type === 'question' ? '❓ Past Paper Question' :
      src.type === 'markscheme' ? '✅ Mark Scheme' :
      src.type === 'resource' ? 'Resource' : 'Source';
    parts.push(`--- [S${index + 1}] ${label}: ${src.title} ---\n${src.content}`);
    total += src.content.length;
  }
  return parts.join('\n\n');
}
