import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chatJSON, SYSTEM_PROMPTS } from '@/lib/ai';
import { requireTextAi, requireVisionAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { transcribeHandwriting } from '@/lib/vision';
import type { GradeResult } from '@/types/ai';
import { upsertBankMistakeReview, upsertMistakeReview } from '@/lib/learning';
import { GRADING_CONCURRENCY, MAX_EXAM_ITEMS, MAX_KEYED_EXAM_ITEMS } from '@/lib/mock-exam-limits';
import { reportError } from '@/lib/error-reporting';
import { EXAM_ITEM_INCLUDE, normalizeExamItem } from '@/lib/mock-exam-items';
import { gradeAgainstKey } from '@/lib/bank-grading';

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
    // A paper still being built, or one whose questions were never chosen, is
    // not a paper. Accepting a submit for either flipped it to 'completed' and
    // hid the fact that generation had broken.
    if (exam.status === 'generating') {
      return NextResponse.json(
        { error: 'This paper is still being prepared. Try again in a moment.' },
        { status: 409 },
      );
    }
    if (exam.status === 'failed') {
      return NextResponse.json(
        { error: exam.generationError ?? 'This paper could not be generated. Generate a new one.' },
        { status: 409 },
      );
    }
    const body = (await req.json()) ?? {};

    /**
     * A submission is one-way: it marks the paper completed, and every later
     * attempt gets a 409. So a malformed body must not be treated as "the
     * student answered nothing" -- `body.answers ?? {}` did exactly that, and
     * a wrong-shaped payload silently scored a real paper zero with no way
     * back. Reproduced by accident while testing: sending an array instead of
     * an object completed a 12-question paper at 0 with no answers stored.
     *
     * An empty object is still allowed. Submitting with nothing written is a
     * real thing that happens when the timer runs out, and refusing it would
     * trap the student in an exam they cannot hand in.
     */
    const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);

    if (body.answers !== undefined && !isPlainRecord(body.answers)) {
      return NextResponse.json(
        { error: 'Expected `answers` to be an object keyed by exam item id.' },
        { status: 400 },
      );
    }
    if (body.images !== undefined && !isPlainRecord(body.images)) {
      return NextResponse.json(
        { error: 'Expected `images` to be an object keyed by exam item id.' },
        { status: 400 },
      );
    }

    const answers: Record<string, string> = body.answers ?? {};
    const images: Record<string, string> = body.images ?? {};

    // Keys that match no item mean the client and the server disagree about
    // this paper. Completing it on that basis is how an exam gets scored zero
    // for a reason nobody can see afterwards.
    const itemIds = new Set(exam.items.map((item) => item.id));
    const submittedKeys = [...Object.keys(answers), ...Object.keys(images)];
    if (submittedKeys.length > 0 && !submittedKeys.some((key) => itemIds.has(key))) {
      return NextResponse.json(
        { error: 'None of the submitted answers match a question on this paper.' },
        { status: 400 },
      );
    }

    // Fetch full item data + markscheme for grading
    const items = await prisma.mockExamItem.findMany({
      where: { mockExamId: exam.id },
      include: EXAM_ITEM_INCLUDE,
      orderBy: { order: 'asc' },
      // Hard ceiling on work per request. Generation clamps to the same
      // constant, so in practice this never truncates a real exam — it is the
      // backstop for rows created before the clamp existed, or by hand.
      //
      // The larger of the two caps, because a keyed item costs a row update
      // rather than an LLM completion; `MAX_EXAM_ITEMS` still bounds what
      // generation lets through unkeyed, which is what bounds the spend.
      take: MAX_KEYED_EXAM_ITEMS,
    });

    // Pre-resolve every item into one shape, and find the legacy mark schemes.
    //
    // A legacy item's mark scheme lives in a separate `ms` document and has to
    // be matched on the paper's coordinates; a bank item's is a direct relation
    // that came back with the item. Only the former needs a query, so only the
    // former gets one.
    const itemsWithMs = await Promise.all(
      items.map(async (item) => {
        let ms: string | null = null;
        let markschemeId: number | null = null;
        if (item.question && item.question.paper.docType === 'qp') {
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
        const normalized = normalizeExamItem(item, ms);
        return { item, normalized, markscheme: normalized?.markschemeContent ?? ms, markschemeId };
      })
    );

    /**
     * Record one graded answer in whichever attempt table the item belongs to.
     *
     * There are two because a foreign key can only point at one question table.
     * A bank item also has no `ReviewItem` path yet -- that table is likewise
     * keyed to the legacy corpus -- so a bank mistake is recorded as an attempt
     * and does not yet raise a review card.
     */
    const recordAttempt = async (
      entry: (typeof itemsWithMs)[number],
      data: {
        answer: string;
        score: number | null;
        isCorrect: boolean | null;
        maxScore: number | null;
        strengths?: string[];
        weaknesses?: string[];
        explanation?: string | null;
        modelAnswer?: string | null;
        gradingStatus: string;
        answerImageUrl?: string | null;
      },
    ) => {
      if (entry.item.bankQuestionId) {
        await prisma.bankQuestionAttempt.create({
          data: {
            userId: user.id,
            questionId: entry.item.bankQuestionId,
            answer: data.answer,
            isCorrect: data.isCorrect,
            score: data.score,
            gradedBy: entry.normalized?.answerLetter ? 'key' : 'ai',
          },
        });
        return;
      }
      if (!entry.item.question) return;
      await prisma.pastPaperAttempt.create({
        data: {
          userId: user.id,
          questionId: entry.item.question.id,
          answer: data.answer,
          score: data.score ?? 0,
          maxScore: data.maxScore,
          isCorrect: data.isCorrect ?? false,
          strengths: data.strengths ?? [],
          weaknesses: data.weaknesses ?? [],
          explanation: data.explanation ?? null,
          modelAnswer: data.modelAnswer ?? null,
          gradingStatus: data.gradingStatus,
          gradingSourceId: entry.markschemeId,
          answerImageUrl: data.answerImageUrl ?? null,
        },
      });
    };

    /** Raise a review card in whichever corpus the item belongs to. */
    const recordMistake = async (
      entry: (typeof itemsWithMs)[number],
      modelAnswer: string | null | undefined,
    ) => {
      if (entry.item.bankQuestionId && entry.normalized) {
        await upsertBankMistakeReview({
          userId: user.id,
          bankQuestionId: entry.item.bankQuestionId,
          // A crop-only question has no text, so the card's prompt falls back
          // to naming it; the strips are rendered from the id either way.
          prompt:
            entry.normalized.content.trim() ||
            `Question ${entry.normalized.number} — see the original paper`,
          answer: modelAnswer || entry.normalized.markschemeContent,
          answerLetter: entry.normalized.answerLetter,
          hasMarkSchemeStrips: entry.normalized.markschemeStrips.length > 0,
          subject: exam.subjectCode ?? 'General',
          topic: 'General',
        });
        return;
      }
      if (!entry.item.question) return;
      await upsertMistakeReview({
        userId: user.id,
        questionId: entry.item.question.id,
        prompt: entry.item.question.content,
        answer: modelAnswer,
        fallbackAnswer: entry.markscheme,
        subject: entry.item.question.paper.subject.name,
        topic: entry.item.question.topic,
      });
    };

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
      async (entry) => {
        const { item, normalized, markscheme, markschemeId } = entry;
        // Unreachable while the CHECK constraint holds; skip rather than throw.
        if (!normalized) return 0;
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
          await prisma.mockExamItem.update({
            where: { id: item.id },
            data: { answer: '', score: 0, isCorrect: false, attemptedAt: new Date(), gradingStatus: markscheme ? 'official' : 'provisional', gradingSourceId: markschemeId },
          });
          await recordAttempt(entry, {
            answer: '',
            score: 0,
            isCorrect: false,
            maxScore: normalized.marks || null,
            weaknesses: ['Question not attempted under exam conditions'],
            explanation: 'Return to this question and complete it without time pressure before reviewing the mark scheme.',
            modelAnswer: markscheme,
            gradingStatus: markscheme ? 'official' : 'provisional',
          });
          await recordMistake(entry, null);
          return 0;
        }

        const max = normalized.marks || 1;

        // A multiple-choice question with a stored key needs no model: compare
        // the letter and be done. This is most of the science papers in the
        // bank, and it is the difference between a paper that grades instantly
        // and one that spends a minute of provider time to reach the same
        // answer -- or times out before it gets there.
        const keyGrade = gradeAgainstKey(answer, normalized.answerLetter);
        if (keyGrade) {
          const score = keyGrade.isCorrect ? max : 0;
          await prisma.mockExamItem.update({
            where: { id: item.id },
            data: {
              answer,
              score,
              isCorrect: keyGrade.isCorrect,
              explanation: keyGrade.isCorrect
                ? null
                : `The correct answer is ${keyGrade.correctLetter}.`,
              modelAnswer: keyGrade.correctLetter,
              strengths: [],
              weaknesses: [],
              gradingStatus: 'official',
              gradingSourceId: markschemeId,
              answerImageUrl,
              attemptedAt: new Date(),
            },
          });
          await recordAttempt(entry, {
            answer,
            score,
            isCorrect: keyGrade.isCorrect,
            maxScore: max,
            modelAnswer: keyGrade.correctLetter,
            gradingStatus: 'official',
            answerImageUrl,
          });
          if (!keyGrade.isCorrect) await recordMistake(entry, keyGrade.correctLetter);
          return score;
        }

        // Nothing left to mark against: a crop-only question has no transcript
        // for the grader to read, and inventing one from the image is a
        // different (and paid) job. Save the work and let the student mark it.
        if (!normalized.content.trim()) {
          await prisma.mockExamItem.update({
            where: { id: item.id },
            data: {
              answer,
              score: null,
              isCorrect: null,
              explanation:
                'This question has not been transcribed yet, so it could not be marked automatically. Compare your answer against the mark scheme.',
              modelAnswer: markscheme,
              gradingStatus: 'ungraded',
              gradingSourceId: markschemeId,
              answerImageUrl,
              attemptedAt: new Date(),
            },
          });
          await recordAttempt(entry, {
            answer,
            score: null,
            isCorrect: null,
            maxScore: max,
            modelAnswer: markscheme,
            gradingStatus: 'ungraded',
            answerImageUrl,
          });
          return 0;
        }

        const questionContent = normalized.content;

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
          ]);

          await recordAttempt(entry, {
            answer,
            score,
            isCorrect,
            maxScore: max,
            strengths: grade.strengths ?? [],
            weaknesses: grade.weaknesses ?? [],
            explanation: grade.explanation ?? null,
            modelAnswer: grade.modelAnswer ?? null,
            gradingStatus: markscheme ? 'official' : 'provisional',
            answerImageUrl,
          });

          if (!isCorrect) await recordMistake(entry, grade.modelAnswer);

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
          await recordUsage({
            userId: user.id,
            feature: 'mock-exam-grade:error',
            model: access.credential.model,
          });
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
          include: EXAM_ITEM_INCLUDE,
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
        items: updated.items.flatMap((i) => {
          const view = normalizeExamItem(i);
          if (!view) return [];
          return [{
            id: i.id,
            sectionTitle: i.sectionTitle,
            order: i.order,
            number: view.number,
            part: view.part,
            subPart: view.subPart,
            content: view.content,
            // A crop-first question is read from the image, not the text.
            strips: view.strips,
            markschemeStrips: view.markschemeStrips,
            marks: view.marks,
            answer: i.answer,
            score: i.score,
            isCorrect: i.isCorrect,
            explanation: i.explanation,
            modelAnswer: i.modelAnswer,
            strengths: i.strengths,
            weaknesses: i.weaknesses,
          }];
        }),
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
