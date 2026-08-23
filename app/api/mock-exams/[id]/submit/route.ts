import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chatJSON, SYSTEM_PROMPTS } from '@/lib/ai';
import { requireTextAi, requireVisionAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { transcribeHandwriting } from '@/lib/vision';
import type { GradeResult } from '@/types/ai';
import { upsertMistakeReview } from '@/lib/learning';
import { GRADING_CONCURRENCY, MAX_EXAM_ITEMS } from '@/lib/mock-exam-limits';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

/**
 * This is the longest-running request the app makes: without an explicit
 * ceiling the platform kills the invocation mid-grading and the student loses
 * the attempt. 60 is Vercel Hobby's maximum; raise it together with
 * `MAX_EXAM_ITEMS` if you move to a plan that allows more.
 */
export const maxDuration = 60;

/**
 * Per-item wall-clock budget for one grading call.
 *
 * Derived from the same arithmetic as MAX_EXAM_ITEMS: the items are graded in
 * `ceil(MAX_EXAM_ITEMS / GRADING_CONCURRENCY)` sequential waves, and the whole
 * submission — waves, OCR, and the database writes — has to land inside
 * `maxDuration`. Reserve a slice of the invocation for everything that is not
 * an LLM call, then split what remains across the waves.
 */
const GRADING_WAVES = Math.ceil(MAX_EXAM_ITEMS / GRADING_CONCURRENCY);
const GRADING_BUDGET_MS = Math.floor(((maxDuration - 12) * 1000) / GRADING_WAVES);

/**
 * Map over `items`, keeping at most `limit` calls in flight, preserving order.
 *
 * Results are written by index rather than pushed, so the returned array lines
 * up with the input regardless of completion order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

// POST /api/mock-exams/[id]/submit
// Body: { answers: { [itemId]: string } }
// Grades each answer with AI and persists results.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Grading a whole paper is the most expensive thing the app does, so both
    // gates run before anything is read: credentials first (is AI on for this
    // account at all?), then the allowance.
    const access = await requireTextAi(user.id);
    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, reason: access.reason, aiDisabled: true },
        { status: access.status }
      );
    }
    // Vision is optional here: a text-only key still grades typed answers, and
    // any attached photo is reported as skipped rather than silently dropped.
    const visionAccess = await requireVisionAi(user.id);

    const allowance = await checkAiAllowance(user.id, {
      requests: MAX_EXAM_ITEMS,
      source: access.source,
    });
    if (!allowance.allowed) {
      return NextResponse.json(
        { error: allowance.message },
        { status: 429 }
      );
    }
    const { id } = await params;

    const exam = await prisma.mockExam.findFirst({
      where: { id, userId: user.id },
      include: { items: true },
    });
    if (!exam) {
      return NextResponse.json({ error: 'Mock exam not found' }, { status: 404 });
    }
    if (exam.status === 'completed') {
      return NextResponse.json({ error: 'This mock exam has already been submitted' }, { status: 409 });
    }
    const body = (await req.json()) ?? {};
    const answers: Record<string, string> = body.answers ?? {};
    const images: Record<string, string> = body.images ?? {};

    // Fetch full item data + markscheme for grading
    const items = await prisma.mockExamItem.findMany({
      where: { mockExamId: exam.id },
      include: {
        question: {
          include: { paper: { include: { subject: true } } },
        },
      },
      orderBy: { order: 'asc' },
      // Hard ceiling on work per request. Grading runs one LLM completion per
      // item (plus an OCR call for any attached photo), so without a cap a
      // single submit is unbounded spend. Generation clamps to the same
      // constant, so in practice this never truncates a real exam — it is the
      // backstop for rows created before the clamp existed, or by hand.
      take: MAX_EXAM_ITEMS,
    });

    // Also pre-fetch markschemes for each item
    const itemsWithMs = await Promise.all(
      items.map(async (item) => {
        let ms: string | null = null;
        let markschemeId: number | null = null;
        if (item.question.paper.docType === 'qp') {
          const found = await prisma.pastPaperQuestion.findFirst({
            where: {
              paper: {
                subjectId: item.question.paper.subjectId,
                year: item.question.paper.year,
                session: item.question.paper.session,
                paperNumber: item.question.paper.paperNumber,
                variant: item.question.paper.variant,
                docType: 'ms',
              },
              number: item.question.number,
              part: item.question.part,
              subPart: item.question.subPart,
            },
            select: { id: true, content: true },
          });
          ms = found?.content ?? null;
          markschemeId = found?.id ?? null;
        }
        return { item, markscheme: ms, markschemeId };
      })
    );

    // Grading is the expensive part: one LLM call per item, plus an OCR call
    // for any photographed working. It used to run strictly sequentially to
    // stay clear of DeepSeek's rate limits — but at 3-8s an item, a 60-item
    // paper takes 3-8 minutes, past every serverless function timeout. A
    // student submitting a full exam got a gateway error and lost the attempt.
    //
    // Four at a time brings a full paper under two minutes while staying well
    // inside the provider's concurrency allowance.
    const scores = await mapWithConcurrency(
      itemsWithMs,
      GRADING_CONCURRENCY,
      async ({ item, markscheme, markschemeId }) => {
        const rawAnswer = (answers[item.id] ?? '').trim();
        const imageUrl = typeof images[item.id] === 'string' ? images[item.id] : null;

        // If an image was attached, OCR it and merge with the typed answer so
        // the text-only grader sees the full working.
        let answer = rawAnswer;
        let answerImageUrl: string | null = null;
        if (imageUrl && visionAccess.ok) {
          try {
            const transcript = await transcribeHandwriting(imageUrl, visionAccess.credential);
            if (transcript && transcript.trim()) {
              answer = rawAnswer
                ? `${rawAnswer}\n\n[Transcribed from handwritten work]\n${transcript.trim()}`
                : transcript.trim();
              answerImageUrl = imageUrl.startsWith('/') ? imageUrl : null;
            }
          } catch (ocrErr) {
            console.error(`Mock exam OCR failed for item ${item.id}:`, ocrErr);
          }
        }

        if (!answer) {
          await prisma.$transaction([
            prisma.mockExamItem.update({
              where: { id: item.id },
              data: { answer: '', score: 0, isCorrect: false, attemptedAt: new Date(), gradingStatus: markscheme ? 'official' : 'provisional', gradingSourceId: markschemeId },
            }),
            prisma.pastPaperAttempt.create({
              data: {
                userId: user.id,
                questionId: item.question.id,
                answer: '',
                score: 0,
                maxScore: item.question.marks || null,
                isCorrect: false,
                strengths: [],
                weaknesses: ['Question not attempted under exam conditions'],
                explanation: 'Return to this question and complete it without time pressure before reviewing the mark scheme.',
                modelAnswer: markscheme,
                gradingStatus: markscheme ? 'official' : 'provisional',
                gradingSourceId: markschemeId,
              },
            }),
          ]);
          await upsertMistakeReview({
            userId: user.id,
            questionId: item.question.id,
            prompt: item.question.content,
            fallbackAnswer: markscheme,
            subject: item.question.paper.subject.name,
            topic: item.question.topic,
          });
          return 0;
        }

        const questionContent = item.question.content;
        const max = item.question.marks || 1;

        try {
          const grade = await chatJSON<GradeResult>(
            [
              { role: 'system', content: SYSTEM_PROMPTS.grader },
              {
                role: 'user',
                content: `Grade the student's answer against the markscheme.

  Question:
  ${questionContent}

  ${markscheme ? `Markscheme:\n${markscheme}\n\n` : ''}Total marks: ${max}

  Student answer:
  ${answer}`,
              },
            ],
            {
              credential: access.credential,
              temperature: 0.2,
              maxTokens: 1200,
              // Grading fans out: MAX_EXAM_ITEMS items at GRADING_CONCURRENCY
              // means ceil(items/concurrency) sequential waves inside one 60s
              // invocation. The default per-call budget in lib/ai.ts assumes a
              // lone request, so give each item its share instead — one slow
              // upstream call must not consume the budget for everything after
              // it and take the whole submission down with it.
              budgetMs: GRADING_BUDGET_MS,
              maxAttempts: 1,
            }
          );

          const score = Math.max(0, Math.min(max, Number(grade.score) || 0));
          const isCorrect = grade.isCorrect ?? score >= max;

          await prisma.$transaction([
            prisma.mockExamItem.update({
              where: { id: item.id },
              data: {
                answer,
                score,
                isCorrect,
                explanation: grade.explanation ?? null,
                modelAnswer: grade.modelAnswer ?? null,
                strengths: grade.strengths ?? [],
                weaknesses: grade.weaknesses ?? [],
                gradingStatus: markscheme ? 'official' : 'provisional',
                gradingSourceId: markschemeId,
                answerImageUrl,
                attemptedAt: new Date(),
              },
            }),
            prisma.pastPaperAttempt.create({
              data: {
                userId: user.id,
                questionId: item.question.id,
                answer,
                score,
                maxScore: max,
                isCorrect,
                strengths: grade.strengths ?? [],
                weaknesses: grade.weaknesses ?? [],
                explanation: grade.explanation ?? null,
                modelAnswer: grade.modelAnswer ?? null,
                gradingStatus: markscheme ? 'official' : 'provisional',
                gradingSourceId: markschemeId,
                answerImageUrl,
              },
            }),
          ]);

          if (!isCorrect) {
            await upsertMistakeReview({
              userId: user.id,
              questionId: item.question.id,
              prompt: item.question.content,
              answer: grade.modelAnswer,
              fallbackAnswer: markscheme,
              subject: item.question.paper.subject.name,
              topic: item.question.topic,
            });
          }

          await recordUsage({
            userId: user.id,
            feature: 'mock-exam-grade',
            tokensOut: 800,
            model: access.credential.model,
          });

          return score;
        } catch (err) {
          // One item failing to grade must not fail the whole submission — the
          // student's other answers are already persisted.
          console.error(`Failed to grade item ${item.id}:`, err);
          // ...but the answer itself must still survive. This used to return
          // without writing anything, so a transient upstream failure threw
          // away work the student had already typed, and the item came back
          // looking unattempted. Persist it as `ungraded` (the same state the
          // practice route uses) so it can be reviewed or re-graded later.
          try {
            await prisma.mockExamItem.update({
              where: { id: item.id },
              data: {
                answer,
                score: null,
                isCorrect: null,
                explanation:
                  'Automatic marking was unavailable for this question. Your answer has been saved — compare it against the mark scheme, or resubmit later.',
                modelAnswer: markscheme,
                gradingStatus: 'ungraded',
                gradingSourceId: markschemeId,
                answerImageUrl,
                attemptedAt: new Date(),
              },
            });
          } catch (persistErr) {
            console.error(`Failed to persist ungraded item ${item.id}:`, persistErr);
          }
          return 0;
        }
      }
    );

    const totalScore = scores.reduce((sum, score) => sum + score, 0);

    const updated = await prisma.mockExam.update({
      where: { id: exam.id },
      data: {
        status: 'completed',
        submittedAt: new Date(),
        score: totalScore,
      },
      include: {
        items: {
          orderBy: { order: 'asc' },
          include: { question: { include: { paper: { include: { subject: true } } } } },
        },
      },
    });

    return NextResponse.json({
      exam: {
        id: updated.id,
        title: updated.title,
        totalMarks: updated.totalMarks,
        score: updated.score,
        submittedAt: updated.submittedAt,
        items: updated.items.map((i) => ({
          id: i.id,
          sectionTitle: i.sectionTitle,
          order: i.order,
          number: i.question.number,
          part: i.question.part,
          subPart: i.question.subPart,
          content: i.question.content,
          marks: i.question.marks,
          answer: i.answer,
          score: i.score,
          isCorrect: i.isCorrect,
          explanation: i.explanation,
          modelAnswer: i.modelAnswer,
          strengths: i.strengths,
          weaknesses: i.weaknesses,
        })),
      },
      // Only ever set when the student attached photos and their credentials
      // name no vision model: the paper was graded, the pictures were not read.
      aiNotice:
        !visionAccess.ok && Object.keys(images).length > 0 ? visionAccess.error : null,
    });
  } catch (error) {
    console.error('Mock exam submit failed:', error);
    await reportError(error, { routePath: '/api/mock-exams/[id]/submit', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to submit mock exam' },
      { status: 500 }
    );
  }
}
