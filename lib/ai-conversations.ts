import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export type AIConversationMode = 'explain' | 'hint' | 'socratic' | 'check' | 'worked-example';

export function conversationTitle(message: string) {
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > 64 ? `${clean.slice(0, 61)}...` : clean || 'New conversation';
}

export async function getOwnedConversation(userId: string, conversationId: string) {
  return prisma.aIConversation.findFirst({ where: { id: conversationId, userId, archived: false } });
}

export async function ensureConversation(input: {
  userId: string;
  conversationId?: string;
  firstMessage: string;
  mode?: AIConversationMode;
  courseId?: string | null;
}) {
  if (input.conversationId) {
    const existing = await getOwnedConversation(input.userId, input.conversationId);
    if (!existing) throw new Error('Conversation not found');
    return existing;
  }
  return prisma.aIConversation.create({
    data: {
      userId: input.userId,
      title: conversationTitle(input.firstMessage),
      mode: input.mode ?? 'explain',
      courseId: input.courseId ?? null,
    },
  });
}

export async function setConversationCourse(userId: string, conversationId: string, courseId: string | null) {
  const conversation = await getOwnedConversation(userId, conversationId);
  if (!conversation) throw new Error('Conversation not found');
  return prisma.aIConversation.update({ where: { id: conversation.id }, data: { courseId } });
}

export async function appendConversationMessage(input: {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  mode?: AIConversationMode;
  sources?: Prisma.InputJsonValue;
  actionType?: string;
  actionData?: Prisma.InputJsonValue;
  intent?: string;
  corpusCoverage?: Prisma.InputJsonValue;
  proposalId?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const message = await tx.aIMessage.create({
      data: {
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        ...(input.sources !== undefined && { sources: input.sources }),
        ...(input.actionType && { actionType: input.actionType }),
        ...(input.actionData !== undefined && { actionData: input.actionData }),
        ...(input.intent && { intent: input.intent }),
        ...(input.corpusCoverage !== undefined && { corpusCoverage: input.corpusCoverage }),
        ...(input.proposalId && { proposalId: input.proposalId }),
      },
    });
    await tx.aIConversation.update({
      where: { id: input.conversationId },
      data: { updatedAt: new Date(), ...(input.mode && { mode: input.mode }) },
    });
    return message;
  });
}

export async function recentConversationMessages(conversationId: string, take = 16) {
  const messages = await prisma.aIMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return messages.reverse();
}
