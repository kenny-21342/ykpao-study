import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chatJSON } from '@/lib/ai';
import { forInteractive, requireTextAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { normalizeExamItem } from '@/lib/mock-exam-items';
import { gradeAgainstKey, optionLettersFor } from '@/lib/bank-grading';
import { bankSubjectName, type BankStrip } from '@/lib/bank-questions';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at this ceiling regardless of what the request
 * is doing. This project is on Pro, where the ceiling is 300s; 60 was a
 * Hobby-era number and was never revisited. One LLM completion.
 */
export const maxDuration = 120;

/**
 * Deterministic question-of-the-day picker.
 *
 * Every student sees the *same* challenge on a given day -- that is what makes
 * it a shared talking point -- so the choice is a seeded hash of the date over
 * a stable, ordered candidate list rather than a random draw.
 *
 * It reads the crop-first bank, and prefers questions whose mark scheme carries
 * an answer key. Two reasons. The pool is 66,758 published questions instead of
 * the few hundred the legacy table holds, so the challenge stops repeating. And
 * a keyed question can be marked by comparing a letter, which is instant and
 * free, where the old path spent about twenty seconds of provider time to
 * return a verdict with no answer attached to it.
 */
type DailyQuestion = {
  id: number;
  rootNumber: number;
  marks: number;
  subject: string;
  year: number;
  bodyMd: string;
  strips: BankStrip[];
  answerLetter: string | null;
  markSchemeStrips: BankStrip[];
  markSchemeMd: string | null;
};

async function pickDailyQuestion(dateKey: string): Promise<DailyQuestion | null> {
  // Ordered by id so the list is stable between days; the seed does the
  // rotating. Restricted to questions with a published mark scheme, because a
  // challenge nobody can be shown the answer to is the defect this replaces.
  const publishedWithMarkScheme = {
    status: 'published',
    paper: { docType: 'qp' },
    markScheme: { status: 'published' },
  } as const;

  // Keyed questions first. A challenge that can be marked by comparing a letter
  // tells the student they were right *and* what the answer was, in the
  // request; without a key the best the day can do is hand back the mark scheme
  // and ask them to mark themselves, which is a weaker thing to open the app
  // to. The fallback exists so an empty keyed pool degrades to that rather than
  // to no challenge at all.
  let candidates = await prisma.bankQuestion.findMany({
    where: {
      ...publishedWithMarkScheme,
      markScheme: { ...publishedWithMarkScheme.markScheme, answerLetter: { not: null } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (candidates.length === 0) {
    candidates = await prisma.bankQuestion.findMany({
      where: publishedWithMarkScheme,
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  }
  if (candidates.length === 0) return null;

  let seed = 0;
  for (let i = 0; i < dateKey.length; i++) seed = (seed * 31 + dateKey.charCodeAt(i)) >>> 0;
  const picked = candidates[seed % candidates.length];

  const question = await prisma.bankQuestion.findUnique({
    where: { id: picked.id },
    include: {
      paper: { include: { subject: true } },
      strips: { include: { asset: true }, orderBy: { ordering: 'asc' } },
      markScheme: {
        include: { strips: { include: { asset: true }, orderBy: { ordering: 'asc' } } },
      },
    },
  });
  if (!question) return null;

  const view = normalizeExamItem({ question: null, bankQuestion: question });
  if (!view) return null;

  return {
    id: question.id,
    rootNumber: question.rootNumber,
    // A mark total is needed to score against; one mark is the honest floor for
    // a multiple-choice question, which is most of what carries a key.
    marks: view.marks || 1,
    subject: bankSubjectName(question.paper.subject),
    year: question.paper.year,
    bodyMd: view.content,
    strips: view.strips,
    answerLetter: view.answerLetter,
    markSchemeStrips: view.markschemeStrips,
    markSchemeMd: view.markschemeContent,
  };
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * GET /api/daily-challenge
 *   Returns today's challenge question plus the user's attempt for today (if any).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dateKey = todayKey();
  const question = await pickDailyQuestion(dateKey);
  if (!question) {
    return NextResponse.json({ error: 'No questions available for the challenge.' }, { status: 404 });
  }

  const attempt = await prisma.dailyChallengeAttempt.findUnique({
    where: { userId_dateKey: { userId: user.id, dateKey } },
  });

  // Pull a small participation snapshot for community feel — total attempts today.
  const participants = await prisma.dailyChallengeAttempt.count({
    where: { dateKey },
  });
  const correctToday = await prisma.dailyChallengeAttempt.count({
    where: { dateKey, isCorrect: true },
  });

  return NextResponse.json({
    dateKey,
    question: {
      id: question.id,
      number: question.rootNumber,
      part: null,
      // Empty for a crop-only question; the client renders `strips` instead.
      content: question.bodyMd,
      strips: question.strips,
      marks: question.marks,
      // Present only for multiple choice. The client uses it to draw option
      // buttons rather than a free-text box asking for one of four letters.
      options: question.answerLetter ? optionLettersFor(question.answerLetter) : null,
      topic: null,
      paper: { year: question.year, subject: question.subject },
    },
    attempt: attempt
      ? {
          answer: attempt.answer,
          score: attempt.score,
          isCorrect: attempt.isCorrect,
          attemptedAt: attempt.attemptedAt,
          // The answer, once they have had their go.
          //
          // Withholding this was the whole defect: the challenge graded a
          // submission, said "Done", and showed nothing to learn from. It is
          // returned only alongside an existing attempt, so it cannot be read
          // off the wire before answering.
          correctAnswer: question.answerLetter,
          markSchemeMd: question.markSchemeMd,
          markSchemeStrips: question.markSchemeStrips,
        }
      : null,
    stats: {
      participants,
      correctToday,
    },
  });
}

const SubmitBody = z.object({
  answer: z.string().min(1).max(5000),
});

/**
 * POST /api/daily-challenge
 *   Submit an answer for today's challenge. Grades with AI (if configured),
 *   records the attempt (one per user per day), and runs achievement checks.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Grading is not what this endpoint is *for*: the attempt is recorded either
  // way, once per day. So a student with no AI credentials still gets to
  // submit -- they get the ungraded path plus an explanation, rather than a 503
  // that would cost them their one attempt of the day.
  //
  // The allowance check moved into the branch that actually spends: most days
  // the answer key settles the question, and refusing a free comparison
  // because someone is over their model budget made no sense.
  const access = await requireTextAi(user.id);

  let parsed;
  try {
    parsed = SubmitBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  const dateKey = todayKey();

  // Block re-submission — one attempt per user per day.
  const existing = await prisma.dailyChallengeAttempt.findUnique({
    where: { userId_dateKey: { userId: user.id, dateKey } },
  });
  if (existing) {
    return NextResponse.json(
      { error: "You've already completed today's challenge.", attempt: existing },
      { status: 409 }
    );
  }

  const question = await pickDailyQuestion(dateKey);
  if (!question) {
    return NextResponse.json({ error: 'No challenge available.' }, { status: 404 });
  }

  let score: number | null = null;
  let isCorrect: boolean | null = null;
  let feedback = '';
  let aiNotice: string | null = null;

  // The answer key settles it without a model, which is the common case: most
  // of what carries a key is multiple choice, and comparing a letter is both
  // instant and free. Only a free-response question reaches the grader below.
  const keyGrade = gradeAgainstKey(parsed.answer, question.answerLetter);

  if (keyGrade) {
    isCorrect = keyGrade.isCorrect;
    score = keyGrade.isCorrect ? question.marks : 0;
    feedback = keyGrade.isCorrect
      ? 'Correct.'
      : `Not quite — the answer is ${keyGrade.correctLetter}.`;
  } else if (!question.bodyMd.trim()) {
    // A crop-only question has no text for a grader to read, and reading it
    // off the image is a different and paid job. Record it and show the mark
    // scheme rather than pretending to have marked it.
    aiNotice =
      'This question has not been transcribed yet, so it could not be marked automatically. Check your answer against the mark scheme.';
  } else if (!access.ok) {
    aiNotice = access.error;
  } else {
    const allowance = await checkAiAllowance(user.id, { source: access.source });
    if (!allowance.allowed) {
      return NextResponse.json({ error: allowance.message }, { status: 429 });
    }
    try {
      const usage: { current: { promptTokens: number; completionTokens: number } | null } = { current: null };
      const result = await chatJSON<{ score: number; feedback: string }>(
        [
          {
            role: 'system',
            content:
              'You are an exam marker. Grade the student answer against the marking guidance. ' +
              'Return JSON: {"score": number out of total marks, "feedback": brief comment}.',
          },
          {
            role: 'user',
            content:
              `Question (worth ${question.marks} marks):\n${question.bodyMd}\n\n` +
              (question.markSchemeMd ? `Mark scheme:\n${question.markSchemeMd}\n\n` : '') +
              `Student answer:\n${parsed.answer}\n\nReturn JSON only.`,
          },
        ],
        {
          credential: forInteractive(access.credential),
          temperature: 0.2,
          maxTokens: 600,
          onUsage: (u) => { usage.current = u; },
        }
      );
      score = Math.max(0, Math.min(question.marks, Math.round(result.score)));
      isCorrect = score >= Math.ceil(question.marks * 0.5);
      feedback = result.feedback ?? '';
      await recordUsage({
        userId: user.id,
        feature: 'daily-challenge',
        // Real counts where the provider gives them; the flat 400 stays only as
        // the fallback for endpoints that omit a usage block.
        tokensIn: usage.current?.promptTokens,
        tokensOut: usage.current?.completionTokens ?? 400,
        model: access.credential.model,
      });
    } catch (err) {
      // Grading failed — record the attempt ungraded so the user isn't blocked.
      console.error('Daily challenge grading failed:', err);
      await recordUsage({ userId: user.id, feature: 'daily-challenge:error', model: access.credential.model });
      aiNotice = 'Your answer was recorded, but the AI marker could not be reached, so it is unscored.';
    }
  }

  const attempt = await prisma.dailyChallengeAttempt.create({
    data: {
      userId: user.id,
      bankQuestionId: question.id,
      dateKey,
      answer: parsed.answer,
      score,
      isCorrect,
    },
  });

  return NextResponse.json({
    ok: true,
    attempt,
    feedback,
    marks: question.marks,
    aiNotice,
    // Whatever happened above, the student now gets to see the answer.
    correctAnswer: question.answerLetter,
    markSchemeMd: question.markSchemeMd,
    markSchemeStrips: question.markSchemeStrips,
  });
}
