import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { aiLimiter } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { plainText } from '@/lib/learning';
import { Prisma } from '@prisma/client';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';
import { toBankSubjectCodes } from '@/lib/bank-questions';
import { scoreRagMatches } from '@/lib/rag';
export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. This one is pure Postgres — a
 * full-text scan across the corpus — but it is unbounded enough to be worth
 * a ceiling above the default.
 */
export const maxDuration = 60;

type SearchResult = {
  id: string;
  type: 'question' | 'markscheme' | 'note' | 'textbook' | 'resource' | 'announcement' | 'discussion' | 'syllabus';
  title: string;
  snippet: string;
  url: string;
  subject?: string | null;
  topic?: string | null;
};

/** Maps a `rag_documents.sourceType` value onto this route's own result type. */
function ragResultType(sourceType: string): SearchResult['type'] {
  if (sourceType === 'question' || sourceType === 'bank-question') return 'question';
  if (sourceType === 'markscheme' || sourceType === 'bank-markscheme') return 'markscheme';
  if (sourceType === 'note' || sourceType === 'cloud-note') return 'note';
  if (sourceType === 'textbook') return 'textbook';
  if (sourceType === 'announcement') return 'announcement';
  if (sourceType === 'discussion') return 'discussion';
  if (sourceType === 'syllabus') return 'syllabus';
  return 'resource';
}

export async function GET(req: NextRequest) {
  const searchParams = new URL(req.url).searchParams;
  const query = searchParams.get('q')?.trim().slice(0, 120) ?? '';
  if (query.length < 2) return NextResponse.json({ results: [], query });
  const user = await getSessionUser();
  // Search reaches across the past-paper corpus, shared notes, and resources.
  // It ran anonymously, which both exposed copyright-sensitive question text
  // to unauthenticated callers and gave them an unmetered fan-out of
  // full-text queries. Both callers (StudyCoach, NotesTextbook) are already
  // behind a sign-in gate, so requiring a session here changes nothing for
  // legitimate use.
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!(await aiLimiter.check(`search:${user.id}`))) {
    return NextResponse.json(
      { error: 'Too many searches. Please wait a moment and try again.' },
      { status: 429 }
    );
  }

  let courseScope;
  try {
    courseScope = await resolveCourseScope({ userId: user?.id, scope: searchParams.get('scope'), courseId: searchParams.get('courseId') });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const words = query.split(/\s+/).filter((word) => word.length > 1).slice(0, 6);
  const terms = words.length > 0 ? words : [query];

  // --- Bank questions (the crop-first corpus students actually browse) ---
  // bodyMd is empty for most questions (crop-only run), so match on metadata
  // and on bodyMd so results appear for free as transcription lands.
  const bankSubjectScope = courseScope.effectiveScope === 'enrolled'
    ? { paper: { subject: { code: { in: toBankSubjectCodes(courseScope.subjectCodes) } } } }
    : {};

  // A syllabus code and an exam year are both four digits, so split them by
  // range rather than by position: "0610 2022" carries one of each, and
  // treating the first match as the code left the year matching nothing at
  // all. An ignored year is worse than no year filter -- the results order by
  // id, so asking for 2022 silently answered with the newest papers instead.
  const fourDigit = query.match(/\d{4}/g) ?? [];
  const isExamYear = (value: string) => Number(value) >= 1990 && Number(value) <= 2099;
  const year = fourDigit.find(isExamYear);
  const syllabusCode = fourDigit.find((value) => !isExamYear(value));
  const questionNumber = query.match(/(?:^|\W)q(?:uestion)?\s*(\d+)/i)?.[1];

  const bankQuestionOr: Prisma.BankQuestionWhereInput[] = [
    ...terms.flatMap((term) => [
      { bodyMd: { contains: term, mode: 'insensitive' as const } },
    ]),
    // Paper and subject metadata — what actually has text today.
    { paper: { subject: { code: { contains: query, mode: 'insensitive' } } } },
    { paper: { subject: { name: { contains: query, mode: 'insensitive' } } } },
  ];
  if (syllabusCode || questionNumber) {
    bankQuestionOr.push({
      AND: [
        ...(syllabusCode ? [{ paper: { subject: { code: syllabusCode } } }] : []),
        ...(questionNumber ? [{ rootNumber: Number(questionNumber) }] : []),
      ],
    });
  }

  // Mark scheme text (answerMd) — 26,531 mark schemes carry real text.
  const bankMsOr: Prisma.BankMarkSchemeWhereInput[] = [
    ...terms.flatMap((term) => [
      { answerMd: { contains: term, mode: 'insensitive' as const } },
    ]),
    { paper: { subject: { code: { contains: query, mode: 'insensitive' } } } },
    { paper: { subject: { name: { contains: query, mode: 'insensitive' } } } },
  ];

  const bankMsSubjectScope = courseScope.effectiveScope === 'enrolled'
    ? { paper: { subject: { code: { in: toBankSubjectCodes(courseScope.subjectCodes) } } } }
    : {};

  const [questions, markschemes, notes, pages, documents, resources] = await Promise.all([
    prisma.bankQuestion.findMany({
      where: {
        status: 'published',
        OR: bankQuestionOr,
        // AND rather than a spread: the scope and the year both constrain
        // `paper`, and two `paper` keys in one object would silently drop one.
        AND: [
          ...(Object.keys(bankSubjectScope).length > 0 ? [bankSubjectScope] : []),
          ...(year ? [{ paper: { year: Number(year) } }] : []),
        ],
      },
      include: { paper: { include: { subject: true } } },
      take: 8,
      orderBy: { id: 'desc' },
    }),
    prisma.bankMarkScheme.findMany({
      where: {
        status: 'published',
        OR: bankMsOr,
        AND: [
          ...(Object.keys(bankMsSubjectScope).length > 0 ? [bankMsSubjectScope] : []),
          ...(year ? [{ paper: { year: Number(year) } }] : []),
        ],
      },
      include: { paper: { include: { subject: true } }, question: { select: { rootNumber: true } } },
      take: 5,
      orderBy: { id: 'desc' },
    }),
    user ? prisma.note.findMany({
      where: {
        AND: [
          { OR: [{ userId: user.id }, { isPublic: true }, { collaborators: { some: { userId: user.id } } }] },
          ...(courseScope.effectiveScope === 'enrolled' ? [{ OR: [{ courseId: { in: courseScope.courseIds } }, { courseId: null }] }] : []),
          { OR: terms.flatMap((term) => [
            { title: { contains: term, mode: 'insensitive' as const } },
            { content: { contains: term, mode: 'insensitive' as const } },
          ]) },
        ],
      },
      take: 6,
      orderBy: { updatedAt: 'desc' },
    }) : Promise.resolve([]),
    user ? prisma.page.findMany({
      where: {
        AND: [
          { OR: [{ section: { notebook: { userId: user.id } } }, { collaborators: { some: { userId: user.id } } }] },
          ...(courseScope.effectiveScope === 'enrolled' ? [{ OR: [{ section: { notebook: { courseId: { in: courseScope.courseIds } } } }, { section: { notebook: { courseId: null } } }] }] : []),
          { OR: terms.flatMap((term) => [
            { title: { contains: term, mode: 'insensitive' as const } },
            { content: { contains: term, mode: 'insensitive' as const } },
            { tags: { has: term } },
          ]) },
        ],
      },
      include: { section: { include: { notebook: true } } },
      take: 6,
      orderBy: { updatedAt: 'desc' },
    }) : Promise.resolve([]),
    user ? prisma.cloudDocument.findMany({
      where: {
        ownerId: user.id,
        deletedAt: null,
        NOT: { clientId: { startsWith: 'page:' } },
        OR: terms.flatMap((term) => [
          { title: { contains: term, mode: 'insensitive' as const } },
          { body: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      take: 6,
      orderBy: { updatedAt: 'desc' },
    }) : Promise.resolve([]),
    prisma.schoolResource.findMany({
      where: {
        ...(courseScope.effectiveScope === 'enrolled' ? { subject: { in: courseScope.subjects } } : {}),
        OR: terms.flatMap((term) => [
          { title: { contains: term, mode: 'insensitive' as const } },
          { description: { contains: term, mode: 'insensitive' as const } },
          { subject: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      take: 6,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // RAG-backed results: announcements, discussion threads, and the past-paper
  // catalogue have no direct `contains`-filter query above, so this is the
  // only path that surfaces them. Restricted to those source types here
  // (rather than also re-surfacing notes/resources/questions the direct
  // queries above already cover) to avoid showing the same document twice
  // under two different ids.
  const enrolledSubjectCodes = courseScope.effectiveScope === 'enrolled'
    ? (courseScope.subjectCodes ?? []).map((code) => code.toLowerCase())
    : [];
  const ragExtraFilters: Prisma.Sql[] = [
    Prisma.sql`d."sourceType" IN ('announcement', 'discussion', 'syllabus')`,
    // A syllabus/past-paper-catalogue document carries a subjectCode; an
    // announcement or discussion thread usually doesn't (they aren't
    // subject-scoped), so only the ones that DO set it get filtered.
    ...(enrolledSubjectCodes.length > 0
      ? [Prisma.sql`(d."subjectCode" IS NULL OR lower(d."subjectCode") IN (${Prisma.join(enrolledSubjectCodes)}))`]
      : []),
  ];
  const ragRows = await scoreRagMatches(query, {
    userId: user.id,
    extraFilters: ragExtraFilters,
    limit: 30,
  });
  const ragByDocument = new Map<string, (typeof ragRows)[number]>();
  for (const row of ragRows) {
    const existing = ragByDocument.get(row.documentId);
    if (!existing || row.rank > existing.rank) ragByDocument.set(row.documentId, row);
  }
  const ragResults = [...ragByDocument.values()]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 6)
    .map((row) => ({
      id: `rag-${row.documentId}`,
      type: ragResultType(row.sourceType),
      title: row.title,
      snippet: plainText(row.content, 240),
      url: row.route ?? '/?tab=materials',
    }));

  const results: SearchResult[] = [
    ...ragResults,
    ...questions.map((question) => ({
      id: `question-${question.id}`,
      type: 'question' as const,
      title: `${question.paper.subject.code} ${question.paper.year} ${question.paper.session.toUpperCase()} P${question.paper.paperNumber}${question.paper.variant ? `v${question.paper.variant}` : ''} Q${question.rootNumber}`,
      snippet: question.bodyMd ? plainText(question.bodyMd, 240) : `${question.paper.subject.name} — Paper ${question.paper.paperNumber}, Question ${question.rootNumber}`,
      url: `/?tab=practice&bqid=${question.id}`,
      subject: question.paper.subject.name,
      topic: null,
    })),
    ...markschemes.map((scheme) => ({
      id: `markscheme-${scheme.id}`,
      type: 'markscheme' as const,
      title: `${scheme.paper.subject.code} ${scheme.paper.year} ${scheme.paper.session.toUpperCase()} P${scheme.paper.paperNumber}${scheme.paper.variant ? `v${scheme.paper.variant}` : ''} Q${scheme.question.rootNumber} mark scheme`,
      snippet: scheme.answerMd ? plainText(scheme.answerMd, 240) : `Mark scheme for Q${scheme.question.rootNumber}`,
      url: `/?tab=practice&bqid=${scheme.questionId}`,
      subject: scheme.paper.subject.name,
      topic: null,
    })),
    ...notes.map((note) => ({
      id: `note-${note.id}`,
      type: 'note' as const,
      title: note.title,
      snippet: plainText(note.content, 240),
      url: '/?tab=materials',
      subject: note.tags[0] ?? null,
    })),
    ...pages.map((page) => ({
      id: `page-${page.id}`,
      type: 'textbook' as const,
      title: `${page.section.notebook.name}: ${page.title}`,
      snippet: plainText(page.content, 240),
      url: '/?tab=materials',
      subject: page.section.notebook.name,
    })),
    ...documents.map((document) => ({
      id: `document-${document.id}`,
      type: 'note' as const,
      title: document.title,
      snippet: plainText(document.body, 240),
      url: '/?tab=materials',
    })),
    ...resources.map((resource) => ({
      id: `resource-${resource.id}`,
      type: 'resource' as const,
      title: resource.title,
      snippet: plainText(resource.description || resource.fileName, 240),
      url: resource.fileUrl,
      subject: resource.subject,
      topic: resource.category,
    })),
  ];

  return NextResponse.json({ results, query, counts: countTypes(results), scope: courseScope });
}

function countTypes(results: SearchResult[]) {
  return results.reduce<Record<string, number>>((counts, result) => {
    counts[result.type] = (counts[result.type] ?? 0) + 1;
    return counts;
  }, {});
}
