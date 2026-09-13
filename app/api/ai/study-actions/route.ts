import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { aiLimiter } from '@/lib/rate-limit';
import { appendConversationMessage, ensureConversation, setConversationCourse } from '@/lib/ai-conversations';
import { createAIActionProposal } from '@/lib/ai-proposals';
import { corpusCoverageForIntent, planCopilotQuery } from '@/lib/copilot-query';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at this ceiling regardless of what the request
 * is doing. This project is on Pro, where the ceiling is 300s; 60 was a
 * Hobby-era number and was never revisited. One LLM completion.
 */
export const maxDuration = 120;

const Body = z.object({
  action: z.enum(['study-week', 'todo-plan', 'daily-practice', 'mock-exam', 'predicted-paper', 'materials']),
  conversationId: z.string().min(1).max(100).optional(),
  subjectCode: z.string().trim().min(1).max(20).optional(),
  courseId: z.string().min(1).max(100).optional(),
});

const actionPrompts = {
  'study-week': 'Build my personalized seven-day study week and create the materials I need.',
  'todo-plan': 'Build a study plan that respects my pending to-do list and turn it into actionable tasks.',
  'daily-practice': 'Schedule one useful past-paper practice question for each day this week.',
  'mock-exam': 'Create a focused mock exam from my weakest available subject and topics.',
  'predicted-paper': 'Generate a predicted paper from the question bank and syllabus structure for the subject I am working on.',
  materials: 'Recommend reading material and study notes for the topics I should improve next.',
} as const;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!(await aiLimiter.check(`study-actions:${user.id}`))) {
    return NextResponse.json(
      { error: 'Too many AI requests. Please wait a moment and try again.' },
      { status: 429 }
    );
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid study action' }, { status: 400 });
  }

  let learnerContext;
  try {
    learnerContext = await getLearnerContext({ userId: user.id, explicitCourseId: body.courseId, legacySubjectCode: body.subjectCode, conversationId: body.conversationId, prompt: actionPrompts[body.action] });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  let conversation;
  try {
    conversation = await ensureConversation({
      userId: user.id,
      conversationId: body.conversationId,
      firstMessage: actionPrompts[body.action],
      courseId: learnerContext.activeCourse?.id ?? null,
    });
  } catch {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  if (conversation.courseId !== (learnerContext.activeCourse?.id ?? null)) {
    conversation = await setConversationCourse(user.id, conversation.id, learnerContext.activeCourse?.id ?? null);
  }

  const userMessage = await appendConversationMessage({
    conversationId: conversation.id,
    role: 'user',
    content: actionPrompts[body.action],
    actionType: body.action,
  });

  if (learnerContext.clarificationRequired) {
    const eligibleCourses = learnerContext.eligibleCourses;
    const answer = `Choose a course before I prepare this draft: ${eligibleCourses.map((course) => course.name).join(', ')}.`;
    const actionData = { clarificationRequired: true, eligibleCourses, contextResolution: 'clarification' };
    const assistantMessage = await appendConversationMessage({ conversationId: conversation.id, role: 'assistant', content: answer, actionType: body.action, actionData: actionData as unknown as Prisma.InputJsonValue });
    return NextResponse.json({ conversationId: conversation.id, conversationTitle: conversation.title, userMessage, assistantMessage: { ...assistantMessage, actionData }, result: actionData });
  }

  try {
    const subjectCode = learnerContext.activeCourse?.scopes[0]?.subjectCode;
    const intent = await planCopilotQuery(actionPrompts[body.action], { subjectCode, level: learnerContext.activeCourse?.level });
    const corpusCoverage = await corpusCoverageForIntent(intent, user.id);
    const proposal = await createAIActionProposal({ userId: user.id, conversationId: conversation.id, action: body.action, subjectCode, coverage: corpusCoverage });
    const answer = `**Draft ready.** ${proposal.payload.summary} Review the dates, durations, and selected activities before confirming.`;
    const actionData = { action: body.action, summary: proposal.payload.summary, proposal, intent, corpusCoverage, resolvedCourse: learnerContext.activeCourse, personalizationApplied: learnerContext.activeCourse?.personalizationEnabled ?? false, contextResolution: learnerContext.contextResolution };
    const assistantMessage = await appendConversationMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: answer,
      actionType: body.action,
      actionData: actionData as unknown as Prisma.InputJsonValue,
      intent: intent.name,
      corpusCoverage: corpusCoverage as unknown as Prisma.InputJsonValue,
      proposalId: proposal.id,
    });
    return NextResponse.json({
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      userMessage: { ...userMessage, actionData: null, sources: null },
      assistantMessage: { ...assistantMessage, actionData, sources: null },
      result: actionData,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Study action failed';
    await appendConversationMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: `I could not complete that action: ${message}`,
      actionType: body.action,
    });
    await reportError(error, { routePath: '/api/ai/study-actions', source: 'route' });
    return NextResponse.json({ error: message, conversationId: conversation.id }, { status: 500 });
  }
}
