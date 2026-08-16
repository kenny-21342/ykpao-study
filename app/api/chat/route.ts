import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]/route';
import { chat, isAIConfigured, SYSTEM_PROMPTS } from '@/lib/ai';
import { aiLimiter, recordUsage } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. One LLM completion.
 */
export const maxDuration = 60;

// Deliberately no 'system' role: the system prompt is server-owned. Accepting
// one from the client let a caller replace SYSTEM_PROMPTS.tutor entirely and
// use our DeepSeek key as a general-purpose LLM.
const Message = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

const Body = z.object({
  messages: z.array(Message).min(1).max(20),
  model: z.string().max(80).optional(),
});

/**
 * POST /api/chat — general AI chat.
 *
 * SECURITY: The previous version hardcoded a third-party API key and proxied
 * through an untrusted endpoint (runanytime.hxi.me) with a curl User-Agent to
 * "bypass restrictions". That key MUST be revoked. This rewrite routes through
 * the same lib/ai.ts (DeepSeek) as every other AI endpoint, requires auth,
 * validates input, rate-limits per user, and records usage.
 */
export async function POST(req: Request) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = Body.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: result.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 }
    );
  }
  const parsed = result.data;

  try {
    // Always server-owned, always first — the schema rejects client system
    // messages, so there is nothing to merge or override here.
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPTS.tutor },
      ...parsed.messages,
    ];

    const reply = await chat(messages, { temperature: 0.7, maxTokens: 2000 });

    await recordUsage({
      userId: session.user.id,
      feature: 'ai-chat',
      tokensOut: Math.ceil(reply.length / 4),
    });

    return NextResponse.json({
      message: reply,
      model: 'deepseek-chat',
    });
  } catch (error) {
    console.error('Chat error:', error);
    const status = (error as { status?: number })?.status ?? 500;
    return NextResponse.json(
      {
        error:
          status === 429
            ? 'The AI service is busy. Please try again in a moment.'
            : 'The AI service is unavailable right now. Please try again.',
      },
      { status }
    );
  }
}
