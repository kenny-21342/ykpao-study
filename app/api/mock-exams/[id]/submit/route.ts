import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chatJSON, SYSTEM_PROMPTS } from '@/lib/ai';
import { requireTextAi, requireVisionAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { transcribeHandwriting, VISION_GRADE_TOKENS_ESTIMATE, type ProviderUsage } from '@/lib/vision';
import { decideGradingMode, runVisionGrading } from '@/lib/grading-router';
import { ensureBankQuestionText } from '@/lib/bank-transcription';
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
 * the attempt. This was 60 because that was Vercel Hobby's maximum, and the
 * arithmetic below still derives everything from it -- but the project is on
 * Pro, where the ceiling is 300, and 60 stopped being enough once a crop-only
 * question could need transcribing before it could be graded. A first touch
 * costs one long vision call *before* the grading call it enables, and at 60
 * the two together did not fit: the transcription aborted mid-flight and the
 * item fell to the ungraded branch every time.
 *
 * It is now the plan maximum, because a vision grade is genuinely that slow.
 * Measured end to end on production, marking one drawn answer takes ~90s: the
 * model writes a whole JSON verdict with strengths, weaknesses, a long
 * explanation and a model answer. Split across the waves below, anything less
 * than 300 gives a wave less time than one such grade needs, and a student who
 * draws inside a mock exam gets that item back unscored -- which is exactly
 * what was happening.
 */
export const maxDuration = 300;

/**
 * Per-item wall-clock budget for one grading call.
 *
 * Derived from the same arithmetic as MAX_EXAM_ITEMS: the items are graded in
 * `ceil(MAX_EXAM_ITEMS / GRADING_CONCURRENCY)` sequential waves, and the whole
 * submission — waves, OCR, and the database writes — has to land inside
 * `maxDuration`. Reserve a slice of the invocation for everything that is not
 * an LLM call, then split what remains across the waves.
 *
 * This governs the vision grader too. It always should have: the number is a
 * property of the invocation, not of which model is doing the marking. It was
 * only ever handed to `chatJSON`, so vision grades silently fell back to
 * lib/vision.ts's 45s module default and timed out on every drawn answer while
 * the route had the correct, larger figure sitting right here.
 */
const GRADING_WAVES = Math.ceil(MAX_EXAM_ITEMS / GRADING_CONCURRENCY);
const GRADING_BUDGET_MS = Math.floor(((maxDuration - 12) * 1000) / GRADING_WAVES);

/** See `claimTranscribeSlot` in the handler for why this is bounded. */
const MAX_TRANSCRIBE_PER_SUBMISSION = 3;

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
    // Grading a whole paper is the most expensive thing the app does, so the
    // allowance gate still runs before anything is read.
    //
    // The *credential* gate used to run here too, and returned 503 before a
    // single answer was persisted. That made this the one grading path in the
    // app with no degraded mode: a student without an API key could generate a
    // paper, sit ninety minutes of it, press Submit and be refused, losing the
    // lot. Every other path -- /api/practice, /api/daily-challenge -- records
    // the attempt and explains itself.
    //
    // It degrades now, and needs no new marking logic to do it. Multiple choice
    // is graded by comparing letters (`gradeAgainstKey`), which never needed a
    // model; everything else takes the ungraded branch that already exists for
    // untranscribed questions, which persists the answer with the mark scheme
    // attached and tells the student to mark against it. That is the same
    // self-marking flow the question bank already uses.
    const access = await requireTextAi(user.id);
    const aiEnabled = access.ok;
    // Narrowed once here: the grading worker is a closure, so `access.ok` no
    // longer narrows the union by the time the credential is needed. Null
    // exactly when `aiEnabled` is false, and every path that reads it is
    // already behind that flag.
    const textCredential = access.ok ? access.credential : null;
    // Vision is optional here: a text-only key still grades typed answers, and
    // any attached photo is reported as skipped rather than silently dropped.
    const visionAccess = await requireVisionAi(user.id);

    if (aiEnabled) {
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

    // A scratchpad autosaves per-item while the student is still working,
    // ahead of any of this submission's attempt rows existing at all -- one
    // batch query rather than one per item inside the grading fan-out below.
    const scratchpads = await prisma.questionScratchpad.findMany({
      where: { userId: user.id, mockExamItemId: { in: items.map((item) => item.id) } },
    });
    const scratchpadByItemId = new Map(scratchpads.map((row) => [row.mockExamItemId, row]));

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
     *
     * This used to add that a bank item "has no `ReviewItem` path yet", which
     * has not been true since `ReviewItem.bankQuestionId` landed:
     * `recordMistake` below routes bank mistakes through
     * `upsertBankMistakeReview`, and 71 of the 82 review cards in production
     * come from the bank. The note is removed rather than corrected because a
     * stale caveat is worse than none -- it had this route's own author
     * scheduling work that was already done.
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
        gradingMode?: 'text' | 'vision';
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
            answerImageUrl: data.answerImageUrl ?? null,
            gradingMode: data.gradingMode ?? 'text',
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
          gradingMode: data.gradingMode ?? 'text',
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

    // How many first-touch transcriptions this one submission may pay for.
    //
    // Transcription is a long call that runs *before* the grading call it
    // enables, so an item that needs one costs roughly double. A paper of
    // untranscribed structured questions would otherwise try it for every
    // item at once and run the invocation out for all of them. Past the cap
    // the remaining items take the existing ungraded branch, exactly as they
    // did before any of this existed, and the next submission picks up where
    // this one stopped -- the transcriptions already paid for are persisted.
    let transcribeBudget = MAX_TRANSCRIBE_PER_SUBMISSION;
    const claimTranscribeSlot = () => {
      if (transcribeBudget <= 0) return false;
      transcribeBudget -= 1;
      return true;
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
        const { item, normalized, markscheme: storedMarkscheme, markschemeId } = entry;
        // Unreachable while the CHECK constraint holds; skip rather than throw.
        if (!normalized) return 0;
        const rawAnswer = (answers[item.id] ?? '').trim();
        const scratchpad = scratchpadByItemId.get(item.id) ?? null;
        const imageUrl =
          (typeof images[item.id] === 'string' ? images[item.id] : null) ??
          scratchpad?.previewImageUrl ??
          null;

        // If an image was attached, OCR it and merge with the typed answer so
        // the text-only grader sees the full working.
        let answer = rawAnswer;
        // Set eagerly (not only when OCR succeeds below): a server-relative
        // URL is worth persisting for vision grading even without OCR.
        const answerImageUrl: string | null = imageUrl && imageUrl.startsWith('/') ? imageUrl : null;
        // A crop-only bank question carries no text, and nothing that reasons
        // over a question can work without it -- which is why the grading
        // router refuses to route one to vision. Transcribe it once, here, so
        // this attempt and every later one on the same question are markable.
        //
        // Three guards keep that from being an expensive habit. A multiple
        // choice question is settled by its stored key a few lines below and
        // needs no transcript at all, so it never pays. Neither does an
        // unattempted question. And a question that already has text short
        // circuits inside `ensureBankQuestionText` without a call.
        const worthTranscribing =
          Boolean(item.bankQuestion) &&
          !normalized.content.trim() &&
          !normalized.answerLetter &&
          Boolean(rawAnswer || imageUrl) &&
          claimTranscribeSlot();
        const transcription =
          worthTranscribing && item.bankQuestion
            ? await ensureBankQuestionText({
                questionId: item.bankQuestion.id,
                strips: normalized.strips.map((strip) => strip.url),
                markschemeStrips: normalized.markschemeStrips.map((strip) => strip.url),
                bodyMd: normalized.content,
                answerMd: storedMarkscheme,
                credential: visionAccess.ok ? visionAccess.credential : null,
                userId: user.id,
              })
            : null;
        const questionContent = transcription?.bodyMd ?? normalized.content;
        const markscheme = storedMarkscheme ?? transcription?.answerMd ?? null;

        const requiresDiagram = Boolean(item.question?.hasDiagram || item.bankQuestion?.requiresDiagram);
        const useVisionGrading =
          decideGradingMode({
            requiresDiagram,
            answerImageUrl,
            hasQuestionText: Boolean(questionContent.trim()),
          }) === 'vision' &&
          Boolean(answerImageUrl) &&
          visionAccess.ok;
        if (imageUrl && visionAccess.ok && !useVisionGrading) {
          try {
            const transcript = await transcribeHandwriting(imageUrl, visionAccess.credential);
            if (transcript && transcript.trim()) {
              answer = rawAnswer
                ? `${rawAnswer}\n\n[Transcribed from handwritten work]\n${transcript.trim()}`
                : transcript.trim();
            }
          } catch (ocrErr) {
            console.error(`Mock exam OCR failed for item ${item.id}:`, ocrErr);
          }
        }
        if (scratchpad) {
          // Keep the row (a reopened past attempt can still show the
          // drawing) -- only stamp it as belonging to a submitted attempt.
          await prisma.questionScratchpad.update({
            where: { id: scratchpad.id },
            data: { finalizedAt: new Date() },
          });
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

        // Nothing left to mark against, for either of two reasons.
        //
        // A crop-only question has no transcript for the text grader to read,
        // and inventing one from the image is a different (and paid) job.
        // Vision grading is the exception -- it reads the answer image directly
        // and doesn't need a transcript.
        //
        // Or AI is switched off for this account entirely. That used to be
        // refused at the door; it lands here instead, which is the same honest
        // state a crop-only question already reaches, with the mark scheme
        // attached so the student can mark it themselves.
        if ((!questionContent.trim() || !aiEnabled) && !useVisionGrading) {
          await prisma.mockExamItem.update({
            where: { id: item.id },
            data: {
              answer,
              score: null,
              isCorrect: null,
              explanation: !aiEnabled
                ? 'AI marking is switched off for your account, so this answer was saved but not marked. Compare it against the mark scheme below and award yourself the marks.'
                : 'This question has not been transcribed yet, so it could not be marked automatically. Compare your answer against the mark scheme.',
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

        const actualGradingMode: 'text' | 'vision' = useVisionGrading ? 'vision' : 'text';
        // Filled in by the vision branch below, and read by the usage record
        // after it, so a vision grade is booked at what the provider says it
        // cost rather than at the flat estimate. A holder rather than a plain
        // `let`, because the branch assigning it is an async callback and
        // control-flow analysis would otherwise narrow the read to `null`.
        const visionUsage: { current: ProviderUsage | null } = { current: null };
        // The text grader has a usage block too; it was simply never read, so
        // every text-graded item booked the same flat estimate as a vision one.
        const textUsage: { current: { promptTokens: number; completionTokens: number } | null } = { current: null };

        try {
          // A vision call that comes back with nothing graded nothing. Left as
          // an empty result it became score 0 stamped `official` below -- a
          // confident zero with no explanation. Throwing routes it into the
          // catch, which already persists the answer as `ungraded` and tells
          // the student their work was saved.
          const grade: Partial<GradeResult> = useVisionGrading && answerImageUrl && visionAccess.ok
            ? await (async () => {
                const outcome = await runVisionGrading({
                  imageUrl: answerImageUrl,
                  questionText: questionContent,
                  studentText: answer,
                  markscheme,
                  totalMarks: max,
                  credential: visionAccess.credential,
                  budgetMs: GRADING_BUDGET_MS,
                  requestTimeoutMs: Math.max(10_000, GRADING_BUDGET_MS - 10_000),
                });
                if (!outcome.graded) throw new Error('Vision grading returned no result');
                visionUsage.current = outcome.usage;
                return outcome.grade;
              })()
            : await chatJSON<GradeResult>(
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
              // Non-null by construction: when `aiEnabled` is false every item
              // that is not vision-graded has already taken the ungraded
              // branch above and returned.
              credential: textCredential!,
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
              onUsage: (u) => { textUsage.current = u; },
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
                gradingMode: actualGradingMode,
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
            gradingMode: actualGradingMode,
          });

          if (!isCorrect) await recordMistake(entry, grade.modelAnswer);

          const gradedWithVision = actualGradingMode === 'vision' && visionAccess.ok;
          await recordUsage({
            userId: user.id,
            feature: gradedWithVision ? 'mock-exam-grade-vision' : 'mock-exam-grade',
            // A vision grade reports its real counts where the provider gives
            // them; the text path still has no usage to read, so it keeps the
            // flat estimate.
            tokensIn: gradedWithVision
              ? visionUsage.current?.tokensIn
              : textUsage.current?.promptTokens,
            tokensOut: gradedWithVision
              ? visionUsage.current?.tokensOut ??
                (visionUsage.current ? undefined : VISION_GRADE_TOKENS_ESTIMATE)
              : textUsage.current?.completionTokens ?? VISION_GRADE_TOKENS_ESTIMATE,
            model: gradedWithVision ? visionAccess.credential.model : textCredential?.model,
          });

          return score;
        } catch (err) {
          // One item failing to grade must not fail the whole submission — the
          // student's other answers are already persisted.
          console.error(`Failed to grade item ${item.id}:`, err);
          await recordUsage({
            userId: user.id,
            feature: actualGradingMode === 'vision' ? 'mock-exam-grade-vision:error' : 'mock-exam-grade:error',
            model: textCredential?.model,
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
      // Why some items came back unmarked. Without this the paper simply looks
      // half-graded, which reads as a broken feature rather than a setting the
      // student can change. `aiDisabled` is kept on the same name the client
      // already branches on for the generate route.
      aiDisabled: !aiEnabled,
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
      // One notice, two causes, most serious first.
      //
      // Text AI off means the whole paper came back unmarked except multiple
      // choice, which is graded from its stored key. Vision off is narrower:
      // the paper was graded, but any attached photo was not read.
      aiNotice: !aiEnabled
        ? (access.ok ? null : access.error)
        : !visionAccess.ok && Object.keys(images).length > 0
          ? visionAccess.error
          : null,
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
