import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { prisma } from '@/lib/prisma';
import { chatJSON, isAIConfigured, SYSTEM_PROMPTS } from '@/lib/ai';
import { aiLimiter, recordUsage } from '@/lib/rate-limit';
import { transcribeHandwriting, isVisionConfigured } from '@/lib/vision';
import type { GradeResult } from '@/types/ai';
import { upsertMistakeReview } from '@/lib/learning';
import { parsePositiveInt } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. One grading call, plus an OCR call when the answer is a photo.
 */
export const maxDuration = 60;

async function getUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return prisma.user.findUnique({ where: { email: session.user.email } });
}

// POST: submit an answer, grade it with AI, persist, return feedback
export async function POST(req: NextRequest) {
  try {
    const user = await getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!(await aiLimiter.check(`practice-grade:${user.id}`))) {
      return NextResponse.json(
        { error: 'Too many AI requests. Please wait a moment and try again.' },
        { status: 429 }
      );
    }
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

    if (answerImage && isVisionConfigured()) {
      try {
        const transcription = await transcribeHandwriting(answerImage);
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
          });
        }
      } catch (ocrErr) {
        console.error('Answer OCR failed (continuing with text only):', ocrErr);
      }
    }

    let grade: Partial<GradeResult> = {};
    if (isAIConfigured()) {
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
          { temperature: 0.2, maxTokens: 1500 }
        );

        await recordUsage({
          userId: user.id,
          feature: 'practice-grade',
          tokensOut: 800,
        });
      } catch (err) {
        console.error('Grading failed:', err);
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
    });
  } catch (error) {
    console.error('Error saving attempt:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save attempt' },
      { status: 500 }
    );
  }
}

// GET: history for the signed-in user
export async function GET(req: NextRequest) {
  try {
    const user = await getUser();
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch attempts' },
      { status: 500 }
    );
  }
}
