import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { chat, isAIConfigured, SYSTEM_PROMPTS } from '@/lib/ai';
import { aiLimiter, recordUsage } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. One LLM completion.
 */
export const maxDuration = 60;

const Body = z.object({
  message: z.string().min(1).max(4000),
  context: z.string().max(4000).optional(),
});

/** POST /api/ai/chat — AI tutor endpoint. Requires auth + rate-limited. */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isAIConfigured()) {
    return NextResponse.json(
      { error: 'AI service not configured (DEEPSEEK_API_KEY missing)' },
      { status: 503 }
    );
  }

  if (!(await aiLimiter.check(session.user.id))) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please slow down.' },
      { status: 429 }
    );
  }

  let parsed;
  try {
    parsed = Body.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  const { message, context } = parsed;

  const userContent = context
    ? `Current screen context:\n${context}\n\nStudent question: ${message}`
    : message;

  try {
    const aiMessage = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPTS.tutor },
        { role: 'user', content: userContent },
      ],
      { temperature: 0.7, maxTokens: 2000 }
    );

    await recordUsage({
      userId: session.user.id,
      feature: 'ai-chat',
      tokensOut: Math.ceil(aiMessage.length / 4),
    });

    return NextResponse.json({ message: aiMessage });
  } catch (error) {
    console.error('Error in AI chat:', error);
    const status = (error as { status?: number })?.status ?? 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get AI response' },
      { status }
    );
  }
}
