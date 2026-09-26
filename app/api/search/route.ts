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
import { bankQuestionIdOf, indexedRoute } from '@/lib/rag-routes';
export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at this ceiling regardless of what the request
 * is doing. This project is on Pro, where the ceiling is 300s; 60 was a
 * Hobby-era number and was never revisited. This one is pure Postgres — a
 * full-text scan across the corpus — but it is unbounded enough to be worth
 * a ceiling above the default.
 */
export const maxDuration = 120;

type SearchResult = {
  id: string;
  type: 'question' | 'markscheme' | 'note' | 'textbook' | 'resource' | 'announcement' | 'discussion' | 'syllabus';
  title: string;
  snippet: string;
  url: string;
  subject?: string | null;
  topic?: string | null;
};

/**
 * Mark-scheme chunks are indexed as the raw `{"marking_points": [...]}` blob
 * the extractor produced, so a snippet taken straight off one reads as JSON
 * rather than as the marking guidance a student is looking for. Flatten it
 * back to prose for display; anything that isn't that shape is returned
 * untouched.
 */
function readableChunk(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{') || !trimmed.includes('marking_points')) return content;
  try {
    const parsed = JSON.parse(trimmed) as { marking_points?: unknown };
    if (!Array.isArray(parsed.marking_points)) return content;
    return parsed.marking_points
      .filter((point): point is string => typeof point === 'string')
      .join(' ')
      .trim() || content;
  } catch {
    // A chunk boundary routinely cuts the JSON mid-object, so parsing fails
    // for exactly the chunks a search is most likely to return. Strip the
    // scaffolding textually instead of showing a student a JSON blob.
    return trimmed
      .replace(/^\{\s*"marking_points"\s*:\s*\[/, '')
      .replace(/"\s*,\s*"/g, ' ')
      .replace(/^"|"\s*\]?\s*\}?\s*$/g, '')
      .replace(/\\"/g, '"')
      .trim() || content;
  }
}

/** Maps a `rag_documents.sourceType` value onto this route's own result type. */
function ragResultType(sourceType: string, documentType?: string | null): SearchResult['type'] {
  // `indexPage` files a student's own notebook page under sourceType
  // 'textbook', so the badge read TEXTBOOK on a page they wrote themselves.
  // documentType carries the honest answer.
  if (documentType === 'notebook-page') return 'note';
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
  // Transcription has landed: 65,572 of the 66,756 published questions carry
  // `bodyMd` as of 26 Sep, against zero when this route was written. The
  // metadata clauses are no longer carrying the query on their own, which is
  // why the text clause below now has to be all-terms rather than any-term.
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

  // Every term must appear, not any one of them. Matching any single term was
  // harmless while `bodyMd` was empty corpus-wide -- it contributed almost
  // nothing, and the metadata clauses below did the work. Once the
  // transcription run filled 64,995 questions (25 Sep) the same clause started
  // matching thousands of rows per query, and because this query orders by
  // `id desc` with no relevance scoring at all, it answered with the eight
  // newest questions containing *one* of the words. Measured on 26 Sep: for
  // twelve queries taken verbatim out of a question's own transcript, the
  // question itself came back 0/12 times, while the query matched 153-13,626
  // rows. Requiring every term cuts those match sets to 1-12 rows and the
  // question comes back 12/12, which is what makes `id desc` acceptable here.
  //
  // The cost is that a query with one absent word returns no bank questions
  // from this path rather than eight wrong ones. That is the better failure:
  // `scoreRagMatches` below still ranks partial and stemmed matches across the
  // rest of the corpus, and notes/resources/papers match independently.
  const bankQuestionOr: Prisma.BankQuestionWhereInput[] = [
    { AND: terms.map((term) => ({ bodyMd: { contains: term, mode: 'insensitive' as const } })) },
    // Paper and subject metadata — what a code/year/question-number lookup hits.
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

  // Mark scheme text (answerMd) — 52,004 of 52,925 mark schemes carry real text.
  // Same all-terms rule as `bankQuestionOr` above, for the same reason.
  const bankMsOr: Prisma.BankMarkSchemeWhereInput[] = [
    { AND: terms.map((term) => ({ answerMd: { contains: term, mode: 'insensitive' as const } })) },
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

  // RAG-backed results: announcements, discussion threads, the syllabus
  // catalogue, and the legacy `past_paper_questions` corpus have no direct
  // `contains`-filter query above, so this is the only path that surfaces
  // them.
  //
  // The past-paper half was once the bulk of it: 12,398 rows carrying real
  // text, against a `bank_questions.bodyMd` that was then empty corpus-wide
  // because the bank was ingested crop-first. Excluding `question`/`markscheme`
  // wholesale therefore did not "avoid a duplicate" -- it made the largest
  // searchable body of text on the platform unreachable from global search
  // entirely, which is why the exclusion is by document key instead.
  //
  // Since 26 Sep the bank is the larger half (64,995 indexed documents), and it
  // is admitted here too. It was excluded wholesale until the deep-link and
  // de-duplication problems below were solved, which cost the largest corpus on
  // the platform its only *ranked* search: the direct query above can only match
  // exact substrings, so it finds a question when every word of the query
  // appears in it verbatim and never otherwise. This block adds stemming and
  // relevance ranking on top of that -- measured 26 Sep at 17/20 recall@20 for
  // a phrase out of a question's own transcript, against 0/20 for anything the
  // substring match misses.
  //
  // `indexedRoute` supplies the `?bqid=` deep link these documents were indexed
  // without, and `seenBankQuestionIds` below keeps a question that both paths
  // found from being listed twice.
  //
  // The duplicate the exclusion was reaching for is real but narrower: the
  // indexer writes `bank-question:`/`bank-markscheme:` documents from the same
  // rows the direct query reads, so those (and only those) are filtered out by
  // document key rather than by source type.
  const enrolledSubjectCodes = courseScope.effectiveScope === 'enrolled'
    ? (courseScope.subjectCodes ?? []).map((code) => code.toLowerCase())
    : [];
  const ragExtraFilters: Prisma.Sql[] = [
    Prisma.sql`d."sourceType" IN ('announcement', 'discussion', 'syllabus', 'question', 'markscheme')`,
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
  // Key on title as well as document id. The past-paper corpus stores a
  // question's plain text and its LaTeX rendering as separate rows, which
  // index as separate documents under the same human-readable title -- so
  // de-duplicating by id alone showed a student the same mark scheme twice,
  // once with `$pV$` and once with `pV`.
  const ragByDocument = new Map<string, (typeof ragRows)[number]>();
  for (const row of ragRows) {
    const key = `${row.sourceType}:${row.title}`;
    const existing = ragByDocument.get(key);
    if (!existing || row.rank > existing.rank) ragByDocument.set(key, row);
  }
  // Mark schemes are longer and denser than the questions they mark, so they
  // out-rank them almost every time; taking the top 6 outright filled the
  // whole RAG block with mark schemes and pushed the questions themselves,
  // and any announcement or discussion, off the end. Cap each type so the
  // block stays a cross-section of what matched.
  // A bank question can be found by both paths at once -- the substring query
  // above and the ranked match here -- and listing it twice reads as a bug even
  // when both hits are correct. Keyed on the question id rather than the
  // document id, because the two paths return different rows for the same
  // question: a `bank-markscheme` document's own id is the mark scheme's.
  const directQuestionIds = new Set(questions.map((question) => String(question.id)));
  const directMarkSchemeQuestionIds = new Set(markschemes.map((scheme) => String(scheme.questionId)));
  const RAG_PER_TYPE_CAP = 3;
  const ragTypeCounts = new Map<string, number>();
  const ragResults = [...ragByDocument.values()]
    .sort((a, b) => b.rank - a.rank)
    .filter((row) => {
      const bankQuestionId = bankQuestionIdOf(row);
      if (bankQuestionId) {
        const shown = row.sourceType === 'markscheme'
          ? directMarkSchemeQuestionIds.has(bankQuestionId)
          : directQuestionIds.has(bankQuestionId);
        if (shown) return false;
      }
      const seen = ragTypeCounts.get(row.sourceType) ?? 0;
      if (seen >= RAG_PER_TYPE_CAP) return false;
      ragTypeCounts.set(row.sourceType, seen + 1);
      return true;
    })
    // Eight rather than six: questions and mark schemes now draw on a corpus
    // 7x the size of the past-paper one and out-rank the other three types far
    // more often, so at six their two caps could fill the block outright and an
    // announcement or discussion would never appear. Eight leaves two slots
    // behind the 3+3 for exactly the cross-section this cap exists to keep.
    .slice(0, 8)
    .map((row) => ({
      id: `rag-${row.documentId}`,
      type: ragResultType(row.sourceType, row.documentType),
      title: row.title,
      snippet: plainText(readableChunk(row.content), 240),
      url: indexedRoute(row) ?? '/?tab=materials',
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
