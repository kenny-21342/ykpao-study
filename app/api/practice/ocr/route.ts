import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { transcribeHandwriting } from '@/lib/vision';
import { requireVisionAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. A vision call over a full-page photo — slower than text completion.
 */
export const maxDuration = 60;

// This route used to carry its own copy of getSessionUser() that resolved the
// session to a user row but skipped the ban and credential-fingerprint checks.
// The duplicate is gone: lib/auth.ts is the single chokepoint, so a password
// reset revokes access here too.

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
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Vision is the one capability a bring-your-own-key user can be missing
    // while everything else works, so the denial carries its own reason code
    // and a message naming exactly what is and is not available.
    const access = await requireVisionAi(user.id);
    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, reason: access.reason, configured: false, aiDisabled: true },
        { status: access.status }
      );
    }

    const allowance = await checkAiAllowance(user.id, { source: access.source });
    if (!allowance.allowed) {
      return NextResponse.json(
        { error: allowance.message },
        { status: 429 }
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

    const text = await transcribeHandwriting(image, access.credential);

    await recordUsage({
      userId: user.id,
      feature: 'ocr-transcribe',
      tokensOut: Math.min(2048, Math.ceil((text?.length ?? 0) / 4)),
      model: access.credential.model,
    });

    if (!text) {
      return NextResponse.json(
        { error: 'Transcription failed. Please type your answer instead.', configured: true },
        { status: 502 }
      );
    }

    return NextResponse.json({ text, questionContext, backend: access.credential.model });
  } catch (error) {
    console.error('OCR transcription error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'OCR transcription failed' },
      { status: 500 }
    );
  }
}
