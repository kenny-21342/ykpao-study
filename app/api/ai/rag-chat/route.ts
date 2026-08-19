import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chat } from '@/lib/ai';
import { requireTextAi } from '@/lib/ai-credentials';
import { retrieveContext } from '@/lib/rag';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { createAIActionProposal } from '@/lib/ai-proposals';
import type { IntakeQuestion } from '@/lib/copilot-types';
import {
  appendConversationMessage,
  ensureConversation,
  recentConversationMessages,
  setConversationCourse,
} from '@/lib/ai-conversations';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';
import type { DeepSeekMessage } from '@/types/ai';

export const dynamic = 'force-dynamic';

/**
 * POST /api/ai/rag-chat
 *
 * Retrieval-Augmented Generation chat endpoint.
 *
 * 1. Takes the student's question + optional conversation history.
 * 2. Searches notes, textbook content, and past paper questions for relevant
 *    passages (full-text search via lib/rag.ts).
 * 3. Feeds those passages as grounding context to the LLM.
 * 4. Returns the answer + the list of sources used (so the student can verify).
 *
 * This replaces the old /api/ai/chat endpoint which answered from the LLM's
 * training data alone. RAG grounds answers in the student's actual textbook,
 * notes, and exam materials.
 */

/**
 * Retrieval plus one LLM completion runs well past the platform's default
 * function limit; without this the invocation is killed part-way and the
 * student's question fails with an opaque gateway error. 60s is the same
 * ceiling every other AI route declares.
 */
export const maxDuration = 60;

const Body = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(2000),
  })).max(20).optional(),
  subjectCode: z.string().max(20).optional(),
  courseId: z.string().min(1).max(100).optional(),
  pageCourseId: z.string().min(1).max(100).optional(),
  pageSubjectCode: z.string().max(20).optional(),
  screenContext: z.string().max(6000).optional(), // current page content for context
  mode: z.enum(['explain', 'hint', 'socratic', 'check', 'worked-example']).default('explain'),
  conversationId: z.string().min(1).max(100).optional(),
});

const MODE_RULES = {
  explain: 'Explain the idea directly, connect it to prerequisite knowledge, and include a concise example when useful.',
  hint: 'Coach the student toward the next step. Do not reveal the final answer or reproduce a complete mark-scheme response.',
  socratic: 'Guide the student through Socratic questioning. Ask ONE focused question at a time that leads them to discover the next step themselves. Never state the answer or solve the problem directly. If the student has made two incorrect attempts at the same step, give a single concrete hint about that specific sub-step — not the full solution. Acknowledge correct reasoning before asking the next question. Always end your response with a question, never a statement.',
  check: 'Evaluate the reasoning the student supplied. Identify the first incorrect or unsupported step, preserve correct work, and suggest one correction.',
  'worked-example': 'Teach with a worked example. If the current screen contains an active exam question, use an analogous example with different values instead of solving that exact question.',
} as const;

function intakeQuestions(input: {
  message: string;
  intent: Awaited<ReturnType<typeof import('@/lib/copilot-query').planCopilotQuery>>;
  profile: { board: string | null; qualification: string | null; subjectCode: string | null; level: string | null; examDate: Date | null; targetGrade: string; currentLevel: string | null; weeklyStudyMinutes: number } | null;
  courseCount: number;
}): IntakeQuestion[] {
  const text = input.message.toLowerCase();
  const questions: IntakeQuestion[] = [];
  const profile = input.profile;
  const isPlan = input.intent.name === 'planning';
  if (!isPlan) return questions;
  if (!input.intent.board && !profile?.board && input.courseCount === 0) questions.push({ key: 'board', label: 'Exam board', prompt: 'Which board are you studying?', type: 'select', options: ['IB', 'Cambridge'] });
  if (!input.intent.qualification && !profile?.qualification && input.courseCount === 0) questions.push({ key: 'qualification', label: 'Qualification', prompt: 'Which qualification should ground the plan?', type: 'select', options: ['IB Diploma', 'Cambridge IGCSE', 'Cambridge AS & A Level'] });
  if (!input.intent.subject && !input.intent.subjectCode && !profile?.subjectCode && input.courseCount !== 1) questions.push({ key: 'subject', label: 'Subject', prompt: 'Which subject should the plan cover?', type: 'text' });
  if (!input.intent.level && !profile?.level && input.courseCount === 0) questions.push({ key: 'level', label: 'Level', prompt: 'What level are you taking?', type: 'text' });
  if (!profile?.examDate && !/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\bexam date\b/.test(text)) questions.push({ key: 'examDate', label: 'Exam date', prompt: 'When is the exam?', type: 'date' });
  if (!/\b(target|aim|achieve|grade)\s*(a\*|a|b|c|[1-7])\b/i.test(input.message) && (!profile || profile.targetGrade === 'A')) questions.push({ key: 'targetGrade', label: 'Target grade', prompt: 'What grade are you aiming for?', type: 'text' });
  if (!profile?.currentLevel && !/\b(current|recent|score|result|mark|grade)\b/i.test(input.message)) questions.push({ key: 'currentLevel', label: 'Current level', prompt: 'What is your current level or recent result?', type: 'text' });
  if (!profile?.weeklyStudyMinutes && !/\b(minute|hour|hours|weekly|week)\b/i.test(input.message)) questions.push({ key: 'weeklyStudyMinutes', label: 'Weekly time', prompt: 'How many minutes can you study each week?', type: 'number' });
  return questions.slice(0, 6);
}

function proposalAction(intent: Awaited<ReturnType<typeof import('@/lib/copilot-query').planCopilotQuery>>, message: string) {
  if (intent.name === 'planning') return 'study-week';
  if (intent.name === 'assessment' && /mock|exam|paper/i.test(message)) return /predict/i.test(message) ? 'predicted-paper' : 'mock-exam';
  if (intent.name === 'practice') return 'daily-practice';
  if (intent.name === 'review') return 'todo-plan';
  return null;
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  let learnerContext;
  try {
    learnerContext = await getLearnerContext({
      userId: user.id,
      explicitCourseId: parsed.courseId,
      pageCourseId: parsed.pageCourseId,
      pageSubjectCode: parsed.pageSubjectCode,
      legacySubjectCode: parsed.subjectCode,
      conversationId: parsed.conversationId,
      prompt: parsed.message,
    });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  let conversation;
  try {
    conversation = await ensureConversation({
      userId: user.id,
      conversationId: parsed.conversationId,
      firstMessage: parsed.message,
      mode: parsed.mode,
      courseId: learnerContext.activeCourse?.id ?? null,
    });
  } catch {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  if (conversation.courseId !== (learnerContext.activeCourse?.id ?? null)) {
    try {
      conversation = await setConversationCourse(user.id, conversation.id, learnerContext.activeCourse?.id ?? null);
    } catch {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
  }

  const persistedHistory = parsed.conversationId
    ? await recentConversationMessages(conversation.id, 16)
    : [];
  const userMessage = await appendConversationMessage({
    conversationId: conversation.id,
    role: 'user',
    content: parsed.message,
    mode: parsed.mode,
  });

  if (learnerContext.clarificationRequired) {
    const options = learnerContext.eligibleCourses.map((course) => ({ id: course.id, name: course.name, subject: course.subject, level: course.level }));
    const clarification = `Which course should I use for this? Choose one: ${options.map((course) => course.name).join(', ')}.`;
    const assistantMessage = await appendConversationMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: clarification,
      mode: parsed.mode,
      actionData: {
        clarificationRequired: true,
        contextResolution: 'clarification',
        eligibleCourses: options,
      } as unknown as Prisma.InputJsonValue,
    });
    return NextResponse.json({
      answer: clarification,
      mode: parsed.mode,
      sources: [],
      contextFound: 0,
      intent: null,
      needsInput: [],
      corpusCoverage: null,
      proposal: null,
      clarificationRequired: true,
      eligibleCourses: options,
      resolvedCourse: null,
      personalizationApplied: false,
      contextResolution: 'clarification',
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
    });
  }

  const access = await requireTextAi(user.id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error, reason: access.reason, aiDisabled: true, conversationId: conversation.id },
      { status: access.status }
    );
  }
  const allowance = await checkAiAllowance(user.id, { source: access.source });
  if (!allowance.allowed) {
    return NextResponse.json({ error: allowance.message, conversationId: conversation.id }, { status: 429 });
  }

  // ---- Step 1: Retrieve relevant context ----
  const personalizationApplied = Boolean(learnerContext.activeCourse?.personalizationEnabled);
  const retrievalQuery = personalizationApplied ? learnerContext.queryRewrite?.value ?? parsed.message : parsed.message;
  const rag = await retrieveContext(retrievalQuery, {
    userId: user.id,
    subjectCode: learnerContext.activeCourse?.scopes.length === 1 ? learnerContext.activeCourse.scopes[0].subjectCode : undefined,
    courseId: learnerContext.activeCourse?.id,
    curriculumScopes: learnerContext.activeCourse?.scopes,
    strictCourseScope: Boolean(learnerContext.activeCourse),
    priorityTopics: personalizationApplied ? learnerContext.weakTopics.slice(0, 4).map((topic) => topic.topic) : undefined,
    maxSources: 6,
  });
  const retrievalDiagnostics = process.env.NODE_ENV !== 'production' ? {
    resolvedScope: learnerContext.activeCourse?.scopes ?? [],
    queryExpansion: retrievalQuery === parsed.message ? null : retrievalQuery,
    filters: {
      courseId: learnerContext.activeCourse?.id ?? null,
      strictCourseScope: Boolean(learnerContext.activeCourse),
      priorityTopics: personalizationApplied ? learnerContext.weakTopics.slice(0, 4).map((topic) => topic.topic) : [],
    },
    rankedCandidates: rag.sources.map((source) => ({ type: source.type, sourceRecordId: source.sourceRecordId, relevance: source.relevance, authority: source.authority })),
    rejectedCandidates: [],
    personalizationFeatures: personalizationApplied ? ['course-scope', 'mastery-priority', ...(learnerContext.queryRewrite ? ['deterministic-query-rewrite'] : [])] : ['course-scope'],
  } : undefined;
  const [profile] = await Promise.all([
    prisma.learningProfile.findUnique({ where: { userId: user.id } }),
  ]);
  const needsInput = intakeQuestions({ message: parsed.message, intent: rag.intent, profile, courseCount: learnerContext.enrolledCourses.length });
  const todoContextLines = !personalizationApplied
    ? 'Activity-based adaptation is disabled for this course.'
    : learnerContext.pendingTasks.length > 0
    ? learnerContext.pendingTasks.slice(0, 6).map((item) => {
        const due = item.dueAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `- ${item.subject} · ${item.topic} · due ${due} · ${item.title}`;
      }).join('\n')
    : 'No pending manual study tasks were found.';

  // ---- Step 2: Build the system prompt with RAG context ----
  const systemPrompt = `You are an expert tutor for the YKPao Study platform. You help students understand concepts through careful, evidence-grounded coaching.

TUTOR MODE: ${parsed.mode}
${MODE_RULES[parsed.mode]}

GROUNDING RULES:
1. Base factual and syllabus-specific claims primarily on the REFERENCE MATERIAL.
2. Cite supporting references inline as [S1], [S2], and so on, matching the source labels below.
3. Do not claim a source supports something it does not say.
4. If the references are insufficient, clearly label the unsupported portion as general knowledge.
5. Never expose a private mark scheme verbatim when the student is asking for a hint.
6. Connect the explanation to the resolved course's syllabus and level.
7. Address one supported misconception or prerequisite gap when it is relevant.
8. End with a proportionate check-for-understanding or next step.

REQUEST INTENT:
${JSON.stringify(rag.intent)}
CORPUS COVERAGE:
${JSON.stringify(rag.corpusCoverage)}

RESOLVED COURSE:
${learnerContext.activeCourse ? `${learnerContext.activeCourse.name} (${learnerContext.activeCourse.level})` : 'All subjects'}
COURSE CONTEXT PROVENANCE:
${JSON.stringify(learnerContext.activeCourseSignal)}
LEARNER SIGNALS (use only to adapt teaching, never as factual evidence):
${JSON.stringify(personalizationApplied ? {
  currentLevel: learnerContext.activeCourse?.currentLevel,
  targetGrade: learnerContext.activeCourse?.targetGrade,
  examDate: learnerContext.activeCourse?.examDate,
  weakTopics: learnerContext.weakTopics.slice(0, 4).map((topic) => ({ topic: topic.topic, mastery: topic.mastery, confidence: topic.confidence })),
  recurringWeaknesses: learnerContext.recurringWeaknesses.slice(0, 4),
  overdueReviews: learnerContext.overdueReviews.slice(0, 4),
} : {})}

${rag.context ? `--- REFERENCE MATERIAL ---
${rag.context}
--- END REFERENCE MATERIAL ---` : 'No relevant reference material was found in the student\'s materials.'}

--- STUDY TASKS ---
${todoContextLines}
--- END STUDY TASKS ---

${parsed.screenContext ? `\nCurrent screen context (what the student is looking at):\n${parsed.screenContext.slice(0, 1000)}` : ''}

FORMATTING RULES:
1. For mathematical formulas, ALWAYS use LaTeX: $x^2$, $$\\frac{a}{b}$$
2. Use markdown: **bold**, *italic*, lists, headers.
3. NEVER use Unicode symbols (², √, ∫). Always use LaTeX.
4. Be concise but thorough. Aim for 2-4 paragraphs unless the student asks for more detail.
5. If a worked example helps, show step-by-step working.`;

  // ---- Step 3: Build message history ----
  const messages: DeepSeekMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(persistedHistory.length > 0 ? persistedHistory : parsed.history ?? []).map((h) => ({
      role: (h.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'content' in h ? h.content : '',
    })),
    { role: 'user', content: parsed.message },
  ];

  // ---- Step 4: Call the LLM ----
  try {
    const answer = await chat(messages, {
      credential: access.credential,
      temperature: 0.4,
      maxTokens: 2000,
    });

    await recordUsage({
      userId: user.id,
      feature: 'rag-chat',
      tokensOut: Math.ceil(answer.length / 4),
      model: access.credential.model,
    });

    let proposal;
    const action = proposalAction(rag.intent, parsed.message);
    if (action && needsInput.length === 0) {
      proposal = await createAIActionProposal({
        userId: user.id,
        conversationId: conversation.id,
        action,
        subjectCode: learnerContext.activeCourse?.scopes[0]?.subjectCode || rag.intent.subjectCode || profile?.subjectCode || undefined,
        coverage: rag.corpusCoverage,
        request: parsed.message,
      });
    }
    const sources = rag.sources.map((source) => ({
      type: source.type,
      title: source.title,
      ...(source.url && { url: source.url }),
      snippet: `${source.content.slice(0, 150)}…`,
      authority: source.authority || (source.type === 'question' || source.type === 'markscheme' ? 'official' : 'personal'),
      sourceRecordId: source.sourceRecordId,
      citation: source.citation,
      pairSourceRecordId: source.pairSourceRecordId,
    }));
    const structuredData = {
      intent: rag.intent,
      corpusCoverage: rag.corpusCoverage,
      needsInput,
      resolvedCourse: learnerContext.activeCourse ? { id: learnerContext.activeCourse.id, name: learnerContext.activeCourse.name, level: learnerContext.activeCourse.level } : null,
      personalizationApplied,
      contextResolution: learnerContext.contextResolution,
      clarificationRequired: false,
      queryRewrite: learnerContext.queryRewrite,
      ...(retrievalDiagnostics ? { retrievalDiagnostics } : {}),
      ...(proposal ? { proposal } : {}),
    };
    const baseAnswer = needsInput.length > 0
      ? `${answer}\n\nI need a few details before I can draft an editable plan.`
      : proposal
        ? `${answer}\n\nI prepared an editable draft. Nothing has been added to your study plan yet.`
        : answer;
    const responseAnswer = learnerContext.activeCourse
      ? `**${learnerContext.activeCourse.name} · ${learnerContext.activeCourse.level}**\n\n${baseAnswer}`
      : baseAnswer;
    const assistantMessage = await appendConversationMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: responseAnswer,
      mode: parsed.mode,
      sources: sources as unknown as Prisma.InputJsonValue,
      actionType: action || undefined,
      actionData: structuredData as unknown as Prisma.InputJsonValue,
      intent: rag.intent.name,
      corpusCoverage: rag.corpusCoverage as unknown as Prisma.InputJsonValue,
      proposalId: proposal?.id,
    });

    return NextResponse.json({
      answer: responseAnswer,
      mode: parsed.mode,
      sources,
      contextFound: rag.totalFound,
      intent: rag.intent,
      needsInput,
      corpusCoverage: rag.corpusCoverage,
      resolvedCourse: learnerContext.activeCourse ? { id: learnerContext.activeCourse.id, name: learnerContext.activeCourse.name, level: learnerContext.activeCourse.level } : null,
      personalizationApplied,
      contextResolution: learnerContext.contextResolution,
      clarificationRequired: false,
      queryRewrite: learnerContext.queryRewrite,
      ...(retrievalDiagnostics ? { retrievalDiagnostics } : {}),
      proposal,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
    });
  } catch (err) {
    console.error('RAG chat failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'AI request failed', conversationId: conversation.id },
      { status: 500 }
    );
  }
}
