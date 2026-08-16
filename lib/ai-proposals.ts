import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { addDays, plainText, startOfDay } from '@/lib/learning';
import { candidateQuestions, learningFocus, mergeFocus, recommendMaterials, loadTodoContext, type FocusTopic } from '@/lib/study-actions';
import type { AIActionProposalPayload, AIActionProposalView, CorpusCoverage, ProposalTask } from '@/lib/copilot-types';

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

type CreateInput = {
  userId: string;
  conversationId?: string;
  action: string;
  subjectCode?: string;
  coverage?: CorpusCoverage;
  request?: string;
};

function focusSubject(focus: FocusTopic[], requested?: string) {
  return requested || focus.find((item) => item.subjectCode)?.subjectCode || undefined;
}

function taskDate(day: number, hour = 17) {
  const date = addDays(startOfDay(), day);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function createTask(input: Omit<ProposalTask, 'clientId' | 'selected'>): ProposalTask {
  return { ...input, clientId: randomUUID(), selected: true };
}

function milestoneDates(examDate: Date | null, count = 4) {
  const start = startOfDay();
  if (!examDate || examDate <= start) return [{ title: 'Start now', date: start.toISOString(), description: 'Use this week to establish a baseline.' }];
  const days = Math.max(7, Math.floor((examDate.getTime() - start.getTime()) / 86_400_000));
  const milestoneCount = Math.min(count, Math.max(1, Math.ceil(days / 28)));
  return Array.from({ length: milestoneCount }, (_, index) => {
    const offset = Math.max(1, Math.round(days * (index + 1) / milestoneCount));
    const date = new Date(Math.min(examDate.getTime(), addDays(start, offset).getTime()));
    return {
      title: index === milestoneCount - 1 ? 'Exam readiness' : `Milestone ${index + 1}`,
      date: date.toISOString(),
      description: index === milestoneCount - 1 ? 'Complete mixed assessment and close remaining gaps.' : 'Build topic coverage with targeted practice and review.',
    };
  });
}

export async function createAIActionProposal(input: CreateInput): Promise<AIActionProposalView> {
  const [profile, focus, todo, questions, materials] = await Promise.all([
    prisma.learningProfile.findUnique({ where: { userId: input.userId } }),
    learningFocus(input.userId),
    loadTodoContext(input.userId),
    candidateQuestions(input.userId, [], input.subjectCode, 80),
    recommendMaterials(input.userId, []),
  ]);
  const combinedFocus = mergeFocus(focus, todo.focus);
  const requestedDate = input.request?.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  const examDate = requestedDate ? new Date(`${requestedDate}T12:00:00.000Z`) : profile?.examDate ?? null;
  const weeklyMinutesMatch = input.request?.match(/weekly (?:time|availability)?\s*:\s*(\d+)/i)?.[1];
  const hoursMatch = input.request?.match(/\b(\d+(?:\.\d+)?)\s*hours?\b/i)?.[1];
  const weeklyMinutes = weeklyMinutesMatch ? Number(weeklyMinutesMatch) : hoursMatch ? Math.round(Number(hoursMatch) * 60) : profile?.weeklyStudyMinutes ?? 300;
  const selectedSubjectCode = focusSubject(combinedFocus, input.subjectCode || profile?.subjectCode || undefined);
  const usableQuestions = questions.filter((question) => !selectedSubjectCode || question.paper.subject.code === selectedSubjectCode);
  const selectedQuestions = usableQuestions.slice(0, input.action === 'daily-practice' ? 7 : 10);
  const sourceQuestions = selectedQuestions.map((question) => ({
    id: question.id,
    title: plainText(question.content, 140),
    subject: question.paper.subject.name,
    topic: question.topic || 'General',
    url: `/?tab=questions-db&qid=${question.id}`,
    selected: true,
    official: true,
  }));
  const tasks: ProposalTask[] = [];

  if (input.action === 'daily-practice' || input.action === 'study-week' || input.action === 'todo-plan') {
    for (let index = 0; index < 7; index += 1) {
      const question = selectedQuestions[index];
      const topic = question?.topic || combinedFocus[index % Math.max(1, combinedFocus.length)]?.topic || 'Core syllabus review';
      tasks.push(createTask({
        title: question ? `Practice: ${topic}` : `Generated practice: ${topic}`,
        subject: question?.paper.subject.name || combinedFocus[index % Math.max(1, combinedFocus.length)]?.subject || profile?.subjectCode || 'Study',
        topic,
        taskType: 'practice',
        sourceRef: question ? { type: 'question', id: String(question.id), url: `/?tab=questions-db&qid=${question.id}`, label: 'Official question' } : { type: 'generated', label: 'Generated from authorized materials' },
        dueAt: taskDate(index),
        durationMinutes: question ? Math.max(15, Math.min(60, question.marks * 4)) : 30,
      }));
    }
  }
  if (input.action === 'study-week' || input.action === 'todo-plan') {
    combinedFocus.slice(0, 4).forEach((item, index) => tasks.push(createTask({
      title: `Review material: ${item.topic}`,
      subject: item.subject,
      topic: item.topic,
      taskType: 'review',
      sourceRef: { type: 'material', label: 'Authorized notes and resources' },
      dueAt: taskDate(Math.min(6, index * 2 + 1), 18),
      durationMinutes: 20,
    })));
  }

  const mockQuestions = input.action === 'mock-exam' || input.action === 'predicted-paper' || input.action === 'study-week' || input.action === 'todo-plan'
    ? selectedQuestions.slice(0, input.action === 'study-week' || input.action === 'todo-plan' ? 8 : 10)
    : [];
  const mockExam = mockQuestions.length > 0
    ? {
        title: input.action === 'predicted-paper' ? 'Predicted practice paper' : `${mockQuestions[0].paper.subject.name} Focus Mock`,
        subjectCode: mockQuestions[0].paper.subject.code,
        questionIds: mockQuestions.map((question) => question.id),
        totalMarks: mockQuestions.reduce((sum, question) => sum + question.marks, 0),
        durationMinutes: Math.max(30, Math.round(mockQuestions.reduce((sum, question) => sum + question.marks, 0) * 1.5)),
        prediction: input.action === 'predicted-paper',
      }
    : undefined;
  if (mockExam && (input.action === 'study-week' || input.action === 'todo-plan' || input.action === 'mock-exam' || input.action === 'predicted-paper')) {
    tasks.push(createTask({
      title: `Complete ${mockExam.title}`,
      subject: mockQuestions[0].paper.subject.name,
      topic: 'Mixed checkpoint',
      taskType: 'mock-exam',
      sourceRef: { type: 'mock-exam', label: 'Created on confirmation' },
      dueAt: taskDate(6, 15),
      durationMinutes: mockExam.durationMinutes,
    }));
  }

  if (input.action === 'study-week' || input.action === 'todo-plan' || input.action === 'daily-practice') {
    let scheduledMinutes = 0;
    for (const task of tasks) {
      task.selected = scheduledMinutes + task.durationMinutes <= weeklyMinutes;
      if (task.selected) scheduledMinutes += task.durationMinutes;
    }
  }

  const materialRows = materials.slice(0, 8).map((material) => ({ ...material, selected: true }));
  const limitations = [...(input.coverage?.limitations ?? [])];
  if (selectedQuestions.length === 0) limitations.push('No official questions matched this subject yet; generated practice will use authorized materials.');
  if (mockExam && mockExam.questionIds.length < 4) limitations.push('The mock is shorter than a full paper because the official corpus is incomplete.');
  const payload: AIActionProposalPayload = {
    version: 1,
    action: input.action,
    title: input.action === 'materials' ? 'Recommended study materials' : input.action === 'daily-practice' ? 'Seven-day practice set' : input.action === 'predicted-paper' ? 'Predicted paper proposal' : 'Editable study plan',
    summary: `${tasks.filter((task) => task.selected).length} activities are ready to review${selectedQuestions.length ? `, including ${selectedQuestions.length} official questions` : ''}.`,
    milestones: milestoneDates(examDate),
    tasks,
    questions: sourceQuestions,
    materials: materialRows,
    mockExam,
    assumptions: [
      examDate ? `Exam date: ${examDate.toISOString().slice(0, 10)}.` : 'No exam date is saved; dates are scheduled from today.',
      `Weekly availability: ${weeklyMinutes} minutes.`,
    ],
    limitations,
    corpusCoverage: input.coverage,
  };
  const proposal = await prisma.aIActionProposal.create({
    data: {
      ownerId: input.userId,
      conversationId: input.conversationId,
      actionType: input.action,
      payload: payload as unknown as Prisma.InputJsonValue,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    },
  });
  return toProposalView(proposal);
}

export function toProposalView(proposal: { id: string; actionType: string; status: string; payload: Prisma.JsonValue; expiresAt: Date; appliedResult: Prisma.JsonValue | null }): AIActionProposalView {
  return {
    id: proposal.id,
    actionType: proposal.actionType,
    status: proposal.status as AIActionProposalView['status'],
    payload: proposal.payload as unknown as AIActionProposalPayload,
    expiresAt: proposal.expiresAt.toISOString(),
    appliedResult: proposal.appliedResult ?? undefined,
  };
}

function editablePayload(original: AIActionProposalPayload, incoming: Partial<AIActionProposalPayload>) {
  const tasksById = new Map(original.tasks.map((task) => [task.clientId, task]));
  const tasks = (incoming.tasks ?? original.tasks).map((candidate) => {
    const current = tasksById.get(candidate.clientId);
    if (!current) return null;
    return {
      ...current,
      title: String(candidate.title ?? current.title).slice(0, 240),
      topic: String(candidate.topic ?? current.topic).slice(0, 160),
      dueAt: String(candidate.dueAt ?? current.dueAt),
      durationMinutes: Math.max(5, Math.min(480, Number(candidate.durationMinutes ?? current.durationMinutes))),
      selected: candidate.selected !== false,
    };
  }).filter(Boolean) as ProposalTask[];
  const questionSelection = new Map((original.questions ?? []).map((question) => [question.id, question]));
  const questions = (incoming.questions ?? original.questions ?? []).map((candidate) => {
    const current = questionSelection.get(candidate.id);
    return current ? { ...current, selected: candidate.selected !== false } : null;
  }).filter(Boolean) as NonNullable<AIActionProposalPayload['questions']>;
  return { ...original, tasks, questions, milestones: incoming.milestones ?? original.milestones };
}

export async function updateAIActionProposal(userId: string, proposalId: string, incoming: Partial<AIActionProposalPayload>) {
  const proposal = await prisma.aIActionProposal.findFirst({ where: { id: proposalId, ownerId: userId } });
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'draft') throw new Error('Only draft proposals can be edited');
  if (proposal.expiresAt <= new Date()) {
    await prisma.aIActionProposal.update({ where: { id: proposal.id }, data: { status: 'expired' } });
    throw new Error('This proposal has expired');
  }
  const payload = editablePayload(proposal.payload as unknown as AIActionProposalPayload, incoming);
  const updated = await prisma.aIActionProposal.update({ where: { id: proposal.id }, data: { payload: payload as unknown as Prisma.InputJsonValue } });
  return toProposalView(updated);
}

export async function cancelAIActionProposal(userId: string, proposalId: string) {
  const result = await prisma.aIActionProposal.updateMany({ where: { id: proposalId, ownerId: userId, status: 'draft' }, data: { status: 'cancelled', cancelledAt: new Date() } });
  if (result.count === 0) throw new Error('Proposal is no longer editable');
  return prisma.aIActionProposal.findUniqueOrThrow({ where: { id: proposalId } }).then(toProposalView);
}

export async function applyAIActionProposal(userId: string, proposalId: string) {
  const result = await prisma.$transaction(async (tx) => {
    let proposal = await tx.aIActionProposal.findFirst({ where: { id: proposalId, ownerId: userId } });
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status === 'applied') return { proposal, result: proposal.appliedResult };
    if (proposal.status !== 'draft') throw new Error(`Proposal is ${proposal.status}`);
    if (proposal.expiresAt <= new Date()) {
      await tx.aIActionProposal.update({ where: { id: proposal.id }, data: { status: 'expired' } });
      throw new Error('This proposal has expired');
    }

    // Claim the draft inside the transaction so concurrent confirmations
    // cannot both create tasks or mock exams from the same proposal.
    const claimed = await tx.aIActionProposal.updateMany({
      where: { id: proposal.id, ownerId: userId, status: 'draft' },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    if (claimed.count === 0) {
      proposal = await tx.aIActionProposal.findFirst({ where: { id: proposalId, ownerId: userId } });
      if (proposal?.status === 'applied') return { proposal, result: proposal.appliedResult };
      throw new Error(`Proposal is ${proposal?.status ?? 'unavailable'}`);
    }

    const payload = proposal.payload as unknown as AIActionProposalPayload;
    const selectedTasks = payload.tasks.filter((task) => task.selected);
    const questionIds = [...new Set([
      ...selectedTasks.map((task) => task.sourceRef?.type === 'question' ? Number(task.sourceRef.id) : null),
      ...(payload.mockExam?.questionIds ?? []),
    ].filter((id): id is number => id !== null && Number.isInteger(id) && id > 0))];
    const questions = questionIds.length > 0
      ? await tx.pastPaperQuestion.findMany({ where: { id: { in: questionIds }, docType: 'qp' }, include: { paper: { include: { subject: true } } } })
      : [];
    if (questions.length !== questionIds.length) throw new Error('One or more selected official questions are no longer available.');
    const questionMap = new Map(questions.map((question) => [question.id, question]));
    if (selectedTasks.length > 0) {
      await tx.studyTask.createMany({
        data: selectedTasks.map((task) => {
          const questionId = task.sourceRef?.type === 'question' ? Number(task.sourceRef.id) : null;
          const question = questionId ? questionMap.get(questionId) : null;
          return {
            userId,
            questionId,
            title: task.title,
            subject: question?.paper.subject.name || task.subject,
            topic: task.topic,
            taskType: task.taskType,
            source: 'ai-proposal',
            dueAt: new Date(task.dueAt),
            durationMinutes: Math.max(5, Math.min(480, task.durationMinutes)),
            sourceRef: { ...task.sourceRef, proposalId: proposal.id } as Prisma.InputJsonValue,
          };
        }),
      });
    }
    let exam: { id: string; title: string; questionCount: number; totalMarks: number } | undefined;
    if (payload.mockExam && payload.mockExam.questionIds.length > 0) {
      const examRow = await tx.mockExam.create({
        data: {
          userId,
          title: payload.mockExam.title,
          description: payload.mockExam.prediction ? 'Prediction generated from observed official paper structure.' : 'Focused official-question mock assembled from the confirmed proposal.',
          subjectCode: payload.mockExam.subjectCode,
          durationMinutes: payload.mockExam.durationMinutes,
          totalMarks: questions.filter((question) => payload.mockExam?.questionIds.includes(question.id)).reduce((sum, question) => sum + question.marks, 0),
          topics: [...new Set(questions.map((question) => question.topic).filter(Boolean))],
          difficulty: payload.mockExam.prediction ? 'predicted' : 'adaptive',
          items: { create: payload.mockExam.questionIds.map((questionId, order) => ({ questionId, sectionTitle: questionMap.get(questionId)?.topic || 'Core questions', order })) },
        },
      });
      exam = { id: examRow.id, title: examRow.title, questionCount: payload.mockExam.questionIds.length, totalMarks: examRow.totalMarks };
    }
    const appliedResult = { taskCount: selectedTasks.length, exam };
    const applied = await tx.aIActionProposal.update({ where: { id: proposal.id }, data: { status: 'applied', appliedAt: new Date(), appliedResult: appliedResult as unknown as Prisma.InputJsonValue } });
    return { proposal: applied, result: appliedResult };
  });
  return { proposal: toProposalView(result.proposal), result: result.result };
}
