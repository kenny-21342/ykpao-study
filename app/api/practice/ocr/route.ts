import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { prisma } from '@/lib/prisma';
import { transcribeHandwriting, isVisionConfigured, getVisionBackend } from '@/lib/vision';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. A vision call over a full-page photo — slower than text completion.
 */
export const maxDuration = 60;

async function getUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return prisma.user.findUnique({ where: { email: session.user.email } });
}

/**
 * POST /api/practice/ocr
 * Body: { image: dataUrl | fileUrl, questionId?: number }
 *
 * Transcribes a photo/screenshot of a student's handwritten answer into plain
 * markdown + LaTeX so it can be graded by the text-only DeepSeek grader.
 *
 * Returns { text, backend } on success, or { error, configured } on failure.
 * Callers should fall back to text-only input when this returns a non-2xx.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowance = await checkAiAllowance(user.id);
    if (!allowance.allowed) {
      return NextResponse.json(
        { error: allowance.message },
        { status: 429 }
      );
    }
    if (!isVisionConfigured()) {
      return NextResponse.json(
        {
          error: 'Vision OCR is not configured. Set SILICONFLOW_API_KEY or GEMINI_API_KEY.',
          configured: false,
        },
        { status: 503 }
      );
    }

    const { image, questionId } = (await req.json()) ?? {};
    if (!image || typeof image !== 'string') {
      return NextResponse.json(
        { error: 'image (data URL or file URL) is required' },
        { status: 400 }
      );
    }

    // Optional: include the question text in the transcription prompt for
    // context-aware OCR (e.g. recognising symbols the question introduced).
    let questionContext: string | null = null;
    if (typeof questionId === 'number' && Number.isFinite(questionId)) {
      const q = await prisma.pastPaperQuestion.findUnique({
        where: { id: questionId },
        select: { content: true },
      });
      if (q) {
        questionContext = q.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
      }
    }

    const text = await transcribeHandwriting(image);

    await recordUsage({
      userId: user.id,
      feature: 'ocr-transcribe',
      tokensOut: Math.min(2048, Math.ceil((text?.length ?? 0) / 4)),
      model: getVisionBackend() ?? 'vision',
    });

    if (!text) {
      return NextResponse.json(
        { error: 'Transcription failed. Please type your answer instead.', configured: true },
        { status: 502 }
      );
    }

    return NextResponse.json({ text, questionContext, backend: getVisionBackend() });
  } catch (error) {
    console.error('OCR transcription error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'OCR transcription failed' },
      { status: 500 }
    );
  }
}
