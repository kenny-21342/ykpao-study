import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/lib/auth';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';
import { parsePositiveInt } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const user = await getSessionUser();
    const courseScope = await resolveCourseScope({
      userId: user?.id,
      scope: searchParams.get('scope'),
      courseId: searchParams.get('courseId'),
    });
    const enrolledPaperWhere = courseScope.effectiveScope === 'enrolled'
      ? { subject: { code: { in: courseScope.subjectCodes } } }
      : {};

    // ---- Filter options ----
    if (action === 'filters') {
      const subjectId = searchParams.get('subject');
      const wherePaper = { ...(subjectId ? { subjectId: parseInt(subjectId, 10) } : {}), ...enrolledPaperWhere };

      const [subjects, years, sessions, paperNumbers, topicRows] = await Promise.all([
        prisma.subject.findMany({
          where: { papers: { some: enrolledPaperWhere } },
          orderBy: { name: 'asc' },
        }),
        prisma.pastPaper.findMany({
          where: enrolledPaperWhere,
          distinct: ['year'],
          orderBy: { year: 'desc' },
          select: { year: true },
        }),
        prisma.pastPaper.findMany({
          where: enrolledPaperWhere,
          distinct: ['session'],
          orderBy: { session: 'asc' },
          select: { session: true },
        }),
        prisma.pastPaper.findMany({
          where: enrolledPaperWhere,
          distinct: ['paperNumber'],
          orderBy: { paperNumber: 'asc' },
          select: { paperNumber: true },
        }),
        // Distinct topics, optionally scoped to the selected subject.
        prisma.pastPaperQuestion.findMany({
          where: { paper: wherePaper },
          distinct: ['topic'],
          orderBy: { topic: 'asc' },
          select: { topic: true },
        }),
      ]);

      return NextResponse.json({
        subjects,
        years: years.map((y) => y.year),
        sessions: sessions.map((s) => s.session),
        paperNumbers: paperNumbers.map((p) => p.paperNumber),
        topics: topicRows.map((t) => t.topic),
        scope: courseScope,
      });
    }

    // ---- Paginated question list ----
    if (action === 'questions') {
      const subjectId = searchParams.get('subject');
      const year = searchParams.get('year');
      const session = searchParams.get('session');
      const paperNumber = searchParams.get('paper');
      const topic = searchParams.get('topic');
      const search = searchParams.get('q')?.trim() ?? ''; // free-text search across code/labels
      const page = parsePositiveInt(searchParams.get('page'), 1);
      const limit = parsePositiveInt(searchParams.get('limit'), 20, 100);
      const docType = searchParams.get('docType') || 'qp';
      const onlyBookmarked = searchParams.get('bookmarked') === '1';

      // Question-level filter: docType separates QP rows from MS rows.
      // Paper-level filters: subject/year/session/paperNumber via the relation.
      const paperWhere = {
        ...enrolledPaperWhere,
        ...(subjectId ? { subjectId: parseInt(subjectId, 10) } : {}),
        ...(year ? { year: parseInt(year, 10) } : {}),
        ...(session ? { session } : {}),
        ...(paperNumber ? { paperNumber: parseInt(paperNumber, 10) } : {}),
      };
      const where = {
        docType,
        ...(topic && topic !== 'General' ? { topic } : {}),
        ...(Object.keys(paperWhere).length > 0 ? { paper: paperWhere } : {}),
        ...(onlyBookmarked && user ? { bookmarks: { some: { userId: user.id } } } : {}),
        // Free-text search: match question content OR topic OR a synthetic
        // code like "0610-S25-P21-Q2". The code isn't a column, so we map
        // common search tokens onto topic/content contains.
        ...(search
          ? {
              OR: [
                { content: { contains: search, mode: 'insensitive' as const } },
                { topic: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };

      const [total, questions] = await Promise.all([
        prisma.pastPaperQuestion.count({ where }),
        prisma.pastPaperQuestion.findMany({
          where,
          include: {
            paper: { include: { subject: true } },
            images: { select: { imagePath: true, pageNumber: true } },
            ...(user ? { bookmarks: { where: { userId: user.id }, select: { id: true } } } : {}),
          },
          orderBy: [
            { paper: { year: 'desc' } },
            { paper: { paperNumber: 'asc' } },
            { ordering: 'asc' },
            { number: 'asc' },
            { part: 'asc' },
            { subPart: 'asc' },
          ],
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);

      const flat = questions.map((q) => ({
        id: q.id,
        paper_id: q.paperId,
        number: q.number,
        part: q.part,
        sub_part: q.subPart,
        content: q.content,
        latex: q.latex,
        marks: q.marks,
        has_diagram: q.hasDiagram,
        diagram_ref: q.diagramRef,
        topic: q.topic,
        images: (q.images ?? []).map((img) => `/extracted_images/${img.imagePath}`),
        ordering: q.ordering,
        year: q.paper.year,
        session: q.paper.session,
        paper_number: q.paper.paperNumber,
        variant: q.paper.variant,
        doc_type: q.paper.docType,
        subject_name: q.paper.subject.name,
        subject_code: q.paper.subject.code,
        bookmarked: 'bookmarks' in q && Array.isArray(q.bookmarks) && q.bookmarks.length > 0,
      }));

      return NextResponse.json({
        questions: flat,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        scope: courseScope,
      });
    }

    // ---- Single question + matching markscheme ----
    if (action === 'question') {
      const questionId = searchParams.get('id');
      if (!questionId) {
        return NextResponse.json({ error: 'Question ID required' }, { status: 400 });
      }

      const question = await prisma.pastPaperQuestion.findUnique({
        where: { id: parseInt(questionId, 10) },
        include: {
          paper: { include: { subject: true } },
          images: { select: { imagePath: true, pageNumber: true } },
        },
      });

      if (!question) {
        return NextResponse.json({ error: 'Question not found' }, { status: 404 });
      }

      let markscheme = null;
      if (question.paper.docType === 'qp') {
        markscheme = await prisma.pastPaperQuestion.findFirst({
          where: {
            docType: 'ms',
            paper: {
              subjectId: question.paper.subjectId,
              year: question.paper.year,
              session: question.paper.session,
              paperNumber: question.paper.paperNumber,
              variant: question.paper.variant,
              docType: 'ms',
            },
            number: question.number,
            part: question.part,
            subPart: question.subPart,
          },
        });
      }

      const flatQuestion = {
        ...question,
        paper_id: question.paperId,
        sub_part: question.subPart,
        has_diagram: question.hasDiagram,
        diagram_ref: question.diagramRef,
        images: (question.images ?? []).map((img) => `/extracted_images/${img.imagePath}`),
        year: question.paper.year,
        session: question.paper.session,
        paper_number: question.paper.paperNumber,
        variant: question.paper.variant,
        doc_type: question.paper.docType,
        subject_name: question.paper.subject.name,
        subject_code: question.paper.subject.code,
      };

      return NextResponse.json({ question: flatQuestion, markscheme });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    if (error instanceof LearnerContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Database error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Database error' },
      { status: 500 }
    );
  }
}
