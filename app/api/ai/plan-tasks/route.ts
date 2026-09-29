import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { createPlanProposal } from '@/lib/ai-proposals';
import { parsePlanTasks } from '@/lib/plan-detection';

export const dynamic = 'force-dynamic';

const Body = z.object({
  /** The assistant message the student pressed the button on. */
  answer: z.string().min(1).max(20_000),
  conversationId: z.string().max(200).optional(),
  subjectCode: z.string().max(40).optional(),
});

/**
 * POST /api/ai/plan-tasks — turn a plan the assistant wrote into an editable
 * draft, for the "Schedule this plan" button in the chat panel.
 *
 * There is deliberately no model call here. The text was written by a model
 * moments ago and is already structured markdown, so `parsePlanTasks` reads it
 * for free and instantly, and the button keeps working when the shared key is
 * unavailable — which is the state a student is most likely to be in. Nothing
 * is written to the schedule either: this only creates a `draft` proposal, and
 * `PATCH /api/ai/proposals/[id]` with `action: 'confirm'` is still what writes
 * `StudyTask` rows, after the student has seen and edited the list.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid request' }, { status: 400 });
  }

  const steps = parsePlanTasks(parsed.answer);
  if (steps.length === 0) {
    return NextResponse.json({ error: 'This answer does not read as a plan with schedulable steps.' }, { status: 422 });
  }

  try {
    const proposal = await createPlanProposal({
      userId: user.id,
      conversationId: parsed.conversationId,
      steps,
      subjectCode: parsed.subjectCode,
    });
    return NextResponse.json({ proposal });
  } catch (error) {
    console.error('Error creating a plan proposal from chat:', error);
    return NextResponse.json({ error: 'The plan could not be prepared.' }, { status: 500 });
  }
}
