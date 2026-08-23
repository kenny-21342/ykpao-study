import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chatJSON, SYSTEM_PROMPTS } from '@/lib/ai';
import { requireTextAi, requireVisionAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { transcribeHandwriting } from '@/lib/vision';
import type { GradeResult } from '@/types/ai';
import { upsertMistakeReview } from '@/lib/learning';
import { parsePositiveInt } from '@/lib/query-params';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. One grading call, plus an OCR call when the answer is a photo.
 */
export const maxDuration = 60;

// This route used to carry its own copy of getSessionUser() that resolved the
// session to a user row but skipped the ban and credential-fingerprint checks.
// The duplicate is gone: lib/auth.ts is the single chokepoint, so a password
// reset revokes access here too.

// POST: submit an answer, grade it with AI, persist, return feedback
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Submitting an answer is not only an AI call — the attempt is persisted
    // and feeds the review queue and the weakness model — so a student with no
    // AI credentials still gets to submit. They get an ungraded attempt and an
    // explanation instead of a 503 that would lose their work.
    const textAccess = await requireTextAi(user.id);
    if (textAccess.ok) {
      const allowance = await checkAiAllowance(user.id, {
        requests: 2,
        source: textAccess.source,
      });
      if (!allowance.allowed) {
        return NextResponse.json(
          { error: allowance.message },
          { status: 429 }
        );
      }
    }
    const aiNotices: string[] = [];
    if (!textAccess.ok) aiNotices.push(textAccess.error);
    const { questionId, answer, timeSpent, drawing, image } = (await req.json()) ?? {};
    if (!questionId || answer == null) {
      return NextResponse.json({ error: 'questionId and answer are required' }, { status: 400 });
    }

    const question = await prisma.pastPaperQuestion.findUnique({
      where: { id: Number(questionId) },
      include: { paper: { include: { subject: true } } },
    });
    if (!question) {
      return NextResponse.json({ error: 'Question not found' }, { status: 404 });
    }

    let markscheme: string | null = null;
    let markschemeId: number | null = null;
    if (question.paper.docType === 'qp') {
      const ms = await prisma.pastPaperQuestion.findFirst({
        where: {
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
        markscheme = ms?.content ?? null;
        markschemeId = ms?.id ?? null;
    }

    // If the student attached a drawing or photo of handwritten work, OCR it
    // and append the transcription to the text answer so the text-only DeepSeek
    // grader can see the full working. Previously the client sent `drawing`
    // silently and the server dropped it — see GitHub issue on the practice flow.
    const answerImage = typeof image === 'string' && image ? image : typeof drawing === 'string' && drawing ? drawing : null;
    let answerImageUrl: string | null = null;
    let gradedAnswer = String(answer);

    // Vision is resolved separately: a text-only key must still grade a typed
    // answer, and must say plainly why the attached photo was ignored.
    const visionAccess = answerImage ? await requireVisionAi(user.id) : null;
    if (visionAccess && !visionAccess.ok) aiNotices.push(visionAccess.error);

    if (answerImage && visionAccess?.ok) {
      try {
        const transcription = await transcribeHandwriting(answerImage, visionAccess.credential);
        if (transcription && transcription.trim()) {
          gradedAnswer = gradedAnswer.trim()
            ? `${gradedAnswer.trim()}\n\n[Transcribed from handwritten work]\n${transcription.trim()}`
            : transcription.trim();
          // Persist the original image URL (data URLs go to /api/upload first;
          // server-relative URLs are kept as-is).
          answerImageUrl = answerImage.startsWith('/') ? answerImage : null;
          await recordUsage({
            userId: user.id,
            feature: 'ocr-transcribe',
            tokensOut: Math.min(2048, Math.ceil(transcription.length / 4)),
            model: visionAccess.credential.model,
          });
        }
      } catch (ocrErr) {
        console.error('Answer OCR failed (continuing with text only):', ocrErr);
      }
    }

    let grade: Partial<GradeResult> = {};
    if (textAccess.ok) {
      try {
        const userContent = `Grade the student's answer against the markscheme.

Question:
${question.content}

${markscheme ? `Markscheme:\n${markscheme}\n\n` : ''}${question.marks ? `Total marks: ${question.marks}\n\n` : ''}Student answer:
${gradedAnswer}`;

        grade = await chatJSON<GradeResult>(
          [
            { role: 'system', content: SYSTEM_PROMPTS.grader },
            { role: 'user', content: userContent },
          ],
          { credential: textAccess.credential, temperature: 0.2, maxTokens: 1500 }
        );

        await recordUsage({
          userId: user.id,
          feature: 'practice-grade',
          tokensOut: 800,
          model: textAccess.credential.model,
        });
      } catch (err) {
        console.error('Grading failed:', err);
        aiNotices.push(
          err instanceof Error && err.message
            ? err.message
            : 'The AI marker could not be reached, so this attempt is unscored.',
        );
      }
    }

    const gradingStatus = markscheme ? 'official' : Object.keys(grade).length > 0 ? 'provisional' : 'ungraded';
    const max = question.marks || grade.maxScore || 1;
    const rawScore = Number(grade.score) || 0;
    const score = gradingStatus === 'ungraded' ? null : Math.max(0, Math.min(max, rawScore));
    const isCorrect = gradingStatus === 'ungraded' ? null : (grade.isCorrect ?? score === max);

    const attempt = await prisma.pastPaperAttempt.create({
      data: {
        userId: user.id,
        questionId: question.id,
        answer: gradedAnswer,
        score,
        maxScore: question.marks || null,
        isCorrect,
        gradingStatus,
        gradingSourceId: markschemeId,
        strengths: grade.strengths ?? [],
        weaknesses: grade.weaknesses ?? [],
        explanation: grade.explanation ?? null,
        modelAnswer: grade.modelAnswer ?? null,
        timeSpent: timeSpent ?? null,
        answerImageUrl,
      },
    });

    if (isCorrect === false) {
      await upsertMistakeReview({
        userId: user.id,
        questionId: question.id,
        prompt: question.content,
        answer: grade.modelAnswer,
        fallbackAnswer: markscheme,
        subject: question.paper.subject.name,
        topic: question.topic,
      });
    }

    const reviewQueueCount = await prisma.reviewItem.count({
      where: { userId: user.id, status: 'active', nextReviewAt: { lte: new Date() } },
    });

    return NextResponse.json({
      attempt,
      feedbackStatus: gradingStatus,
      provisional: gradingStatus !== 'official',
      markSchemeQuestionId: markschemeId,
      reviewItemCreated: isCorrect === false,
      reviewQueueCount,
      aiNotices,
    });
  } catch (error) {
    console.error('Error saving attempt:', error);
    await reportError(error, { routePath: '/api/practice', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save attempt' },
      { status: 500 }
    );
  }
}

// GET: history for the signed-in user
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const limit = parsePositiveInt(searchParams.get('limit'), 20, 100);

    const [total, attempts] = await Promise.all([
      prisma.pastPaperAttempt.count({ where: { userId: user.id, gradingStatus: 'official' } }),
      prisma.pastPaperAttempt.findMany({
        where: { userId: user.id },
        include: {
          question: {
            include: { paper: { include: { subject: true } } },
          },
        },
        orderBy: { attemptedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return NextResponse.json({
      attempts,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching attempts:', error);
    await reportError(error, { routePath: '/api/practice', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch attempts' },
      { status: 500 }
    );
  }
}
