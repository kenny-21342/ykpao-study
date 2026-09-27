import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chat } from '@/lib/ai';
import { forInteractive, requireTextAi } from '@/lib/ai-credentials';
import { loadSharedModels, nextSharedModel, resolveSharedModel } from '@/lib/shared-models';
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
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

/**
 * How much of the serialised screen context reaches the model.
 *
 * The schema accepts 6,000 characters and this used to pass on 1,000 of them,
 * which was invisible while three surfaces reported a single line each. Now
 * that the bank, mock exams, study views, threads and the resource tree all
 * report, 1,000 characters silently cut the end off -- and the end is where
 * `toPromptString` puts the subject and the do-not-answer instruction for a
 * live exam. Matched to the schema so nothing is accepted and then dropped.
 */
const SCREEN_CONTEXT_CHARS = 6000;

/** Cap on the question wording pulled from the database, in characters. */
const ON_SCREEN_QUESTION_CHARS = 2000;

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
export const maxDuration = 120;

/**
 * Wall-clock budget for the tutor's completion.
 *
 * The 45s default in lib/ai.ts assumed a lone request with time to spare. It
 * did not survive the shared provider: measured medians run 7-27s with a tail
 * past 90, and a tutor question timed out in production with
 * "The AI service did not respond in time."
 *
 * The retrieval above is already done by this point, so the remaining
 * invocation belongs to the completion; 50s leaves the platform's 60s ceiling
 * room to serialise a reply rather than being killed mid-write. Paired with
 * AI_INTERACTIVE_MODEL, which is the part that makes the call fast rather than
 * merely more patient.
 */
const TUTOR_BUDGET_MS = 50_000;

/**
 * The point past which no second attempt is started, measured from the top of
 * the request.
 *
 * `maxDuration` above is 120s and the whole request has to fit inside it —
 * retrieval, two completions at most, and the conversation writes after them.
 * 95s leaves 25s for the reply to be assembled and serialised; overrunning
 * instead of retrying would turn a recoverable failure into a killed
 * invocation, which is strictly worse for the student.
 */
const TUTOR_DEADLINE_MS = 95_000;

/**
 * Below this, a retry is not worth starting.
 *
 * `lib/ai.ts` refuses to begin an attempt with under 1s left, so anything
 * shorter than a realistic completion just spends the remaining time and
 * fails with a less useful error than the one already in hand. Measured
 * medians on this gateway run 5-25s; 10s is enough for the fast models to
 * land and honest about the rest.
 */
const MIN_RETRY_MS = 10_000;

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
  // The bank question on screen, resolved to its wording server-side.
  //
  // The client cannot send the text: `BankQuestionView` carries `hasText` and
  // never `bodyMd`, deliberately, so the practice UI cannot leak a transcript
  // it has no use for. That left the tutor knowing a student was on "a past
  // paper question" and nothing about which one, which is the difference
  // between answering "how do I do this?" and guessing.
  bankQuestionId: z.number().int().positive().max(100_000_000).optional(),
  mode: z.enum(['explain', 'hint', 'socratic', 'check', 'worked-example']).default('explain'),
  conversationId: z.string().min(1).max(100).optional(),
  // Which shared model to answer with. Bounded here only for shape; the value
  // itself is checked against the catalogue below, never trusted.
  model: z.string().min(1).max(100).optional(),
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
  // Everything below is measured against this, so the retry's budget accounts
  // for the retrieval that already happened rather than assuming a fresh start.
  const requestStart = Date.now();
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
    // The chips the client renders below this already name every option, with
    // the level that tells two same-named courses apart. Enumerating them in
    // prose as well repeated the list -- and repeated it *worse*, since
    // `name` alone renders "Computer Science, ... Computer Science" for a
    // student taking it at both IGCSE and IB.
    const clarification = options.length === 2
      ? `Did you mean ${options[0].name} (${options[0].level}) or ${options[1].name} (${options[1].level})?`
      : 'That could match more than one of your courses — which one did you mean?';
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
  /**
   * Which model actually answers.
   *
   * `parsed.model` is the student's pick from the tutor and comes off an
   * attacker-controlled body, so it is never used as given: `resolveSharedModel`
   * requires it to be a model the gateway is currently carrying. Without that
   * test a request could name the most expensive model the gateway sells and
   * spend the operator's credit on it.
   *
   * It also routes around an outage. Thirteen of the gateway's twenty models
   * were down when this was written, and which thirteen moves through the day,
   * so a student's saved choice being unavailable is the ordinary case rather
   * than a rare one — it falls through to the configured model, then to
   * anything that is up, rather than failing the message.
   *
   * Shared key only. A student who supplied their own key chose their own
   * model, and the rule that it is never substituted holds here too.
   *
   * Applied after `forInteractive`, so an explicit choice outranks the latency
   * swap.
   */
  const interactive = forInteractive(access.credential);
  const credential = await (async () => {
    const base = interactive;
    if (access.credential.source !== 'shared') return base;
    // Consulted on every shared call, not only when the student picked
    // something. Skipping it when they had not was an optimisation that
    // introduced a real bug: with SHARED_AI_MODEL unset the configured value
    // falls back to `deepseek-chat`, which this gateway does not carry, and
    // nothing would have corrected it -- every message would have 503'd. The
    // resolver is what makes a wrong configured model survivable.
    //
    // Tight timeout, because a student is watching a spinner. Failure is safe
    // in both directions: FALLBACK_MODELS still resolves to a model the key
    // can call, and an unresolvable request is never honoured as given.
    const models = await loadSharedModels({ timeoutMs: 2_500 });
    return { ...base, model: resolveSharedModel(models, parsed.model, base.model) };
  })();

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
  // Resolved in parallel with the profile read, since neither depends on the
  // other and this sits on the latency path of every message.
  //
  // `status: 'published'` is the access control: the same rule the practice UI
  // enforces, so the tutor cannot be used to read a question that is still
  // held in review. An empty `bodyMd` resolves to null rather than an empty
  // string, which is what lets `toPromptString` tell the model to ask the
  // student instead of inventing the wording.
  const [profile, onScreenQuestionRow] = await Promise.all([
    prisma.learningProfile.findUnique({ where: { userId: user.id } }),
    parsed.bankQuestionId
      ? prisma.bankQuestion.findFirst({
          where: { id: parsed.bankQuestionId, status: 'published' },
          select: { bodyMd: true },
        })
      : Promise.resolve(null),
  ]);
  // Only the question, never `answerMd`. The tutor is meant to teach the
  // student through it, and a mark scheme in the prompt is an answer key one
  // "just tell me" away.
  const onScreenQuestion = onScreenQuestionRow?.bodyMd?.trim()
    ? onScreenQuestionRow.bodyMd.trim().slice(0, ON_SCREEN_QUESTION_CHARS)
    : null;
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

${parsed.screenContext ? `\nCurrent screen context (what the student is looking at):\n${parsed.screenContext.slice(0, SCREEN_CONTEXT_CHARS)}` : ''}${onScreenQuestion ? `\nThe full wording of the question they are looking at:\n${onScreenQuestion}` : ''}

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
  // The provider's own token counts when it reports them; the char/4
  // estimates below are only the fallback for endpoints that omit usage.
  const usage: { current: { promptTokens: number; completionTokens: number } | null } = { current: null };
  /**
   * The model that actually answered, which is not always `credential.model`.
   *
   * A failed shared call is retried once on a different model below, so both
   * the usage row and the error row have to name what was really called —
   * otherwise `/usage` and the admin's error counts attribute a second model's
   * spend, or a first model's failure, to the wrong one.
   */
  let answeredWith = credential.model;
  const complete = (model: string, budgetMs: number) => {
    usage.current = null;
    return chat(messages, {
      credential: { ...credential, model },
      temperature: 0.4,
      maxTokens: 2000,
      budgetMs,
      onUsage: (u) => { usage.current = u; },
    });
  };

  try {
    let answer: string;
    try {
      answer = await complete(credential.model, TUTOR_BUDGET_MS);
    } catch (firstError) {
      /**
       * One retry, on a different model.
       *
       * `resolveSharedModel` already routes around a model the status page
       * says is down. This covers the case it cannot see: a model the gateway
       * lists and the page shows as up, which fails anyway. That is the
       * ordinary failure here rather than a rare one — the gateway answers
       * `503 No available channel for model X under group Y` for models its
       * own /v1/models advertises, and which models those are moves through
       * the day.
       *
       * Bounded three ways, because a retry that can double a request's cost
       * or lifetime is worse than the failure it fixes:
       *  - shared key only. A student who supplied their own key chose their
       *    own model, and substituting it is not ours to do.
       *  - one attempt, never a loop.
       *  - only with real time left against the platform ceiling, and the
       *    second attempt gets whatever remains rather than a fresh budget.
       */
      const remainingMs = TUTOR_DEADLINE_MS - (Date.now() - requestStart);
      const alternative =
        access.credential.source === 'shared' && remainingMs >= MIN_RETRY_MS
          // Served from the 60s cache this request already populated, so the
          // tight timeout is a backstop rather than the expected path.
          ? nextSharedModel(await loadSharedModels({ timeoutMs: 1_500 }), credential.model, interactive.model)
          : null;
      if (!alternative) throw firstError;

      console.warn(
        `[rag-chat] ${credential.model} failed, retrying on ${alternative}:`,
        firstError instanceof Error ? firstError.message : firstError,
      );
      // The failed attempt is its own usage event. Without this the retry
      // hides the first model's failure from the admin's error counts, and a
      // model that is failing every request looks healthy.
      await recordUsage({ userId: user.id, feature: 'rag-chat:error', model: credential.model });
      answeredWith = alternative;
      answer = await complete(alternative, Math.min(TUTOR_BUDGET_MS, remainingMs));
    }

    await recordUsage({
      userId: user.id,
      feature: 'rag-chat',
      tokensIn: usage.current?.promptTokens ?? Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4),
      tokensOut: usage.current?.completionTokens ?? Math.ceil(answer.length / 4),
      model: answeredWith,
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
      // Offered, not demanded, and only while nothing is scoped yet: the
      // client renders these as chips under the answer. Once a course is
      // resolved -- including by tapping one of these -- it sticks to the
      // conversation and the offer stops.
      ...(learnerContext.activeCourse ? {} : {
        eligibleCourses: learnerContext.eligibleCourses.map((course) => ({
          id: course.id, name: course.name, subject: course.subject, level: course.level,
        })),
      }),
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
    // The attempt is a usage event even when it produced nothing — recording
    // it under the :error label is what makes the admin's error counts mean
    // something. The catch also covers the persistence after the model call,
    // so a small number of :error rows are succeeded-then-failed-to-save.
    await recordUsage({ userId: user.id, feature: 'rag-chat:error', model: answeredWith });
    await reportError(err, { routePath: '/api/ai/rag-chat', source: 'route' });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'AI request failed', conversationId: conversation.id },
      { status: 500 }
    );
  }
}
