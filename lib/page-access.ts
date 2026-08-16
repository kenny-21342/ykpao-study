import { prisma } from '@/lib/prisma';

export type PageRole = 'owner' | 'editor' | 'viewer';

export async function getPageAccess(pageId: string, userId: string) {
  const page = await prisma.page.findFirst({
    where: {
      id: pageId,
      OR: [
        { section: { notebook: { userId } } },
        { collaborators: { some: { userId } } },
      ],
    },
    include: {
      section: { include: { notebook: { include: { user: { select: { id: true, name: true, email: true, image: true } } } } } },
      collaborators: { select: { userId: true, role: true } },
    },
  });
  if (!page) return null;

  const role: PageRole = page.section.notebook.userId === userId
    ? 'owner'
    : (page.collaborators.find((collaborator) => collaborator.userId === userId)?.role === 'editor' ? 'editor' : 'viewer');

  return { page, role, ownerId: page.section.notebook.userId };
}

export function canEditPage(role: PageRole) {
  return role === 'owner' || role === 'editor';
}

export async function syncPageToCloud(input: {
  id: string;
  title: string;
  content: string;
  ownerId: string;
}) {
  try {
    const existing = await prisma.cloudDocument.findUnique({
      where: { ownerId_clientId: { ownerId: input.ownerId, clientId: `page:${input.id}` } },
      select: { revision: true },
    });
    await prisma.cloudDocument.upsert({
      where: { ownerId_clientId: { ownerId: input.ownerId, clientId: `page:${input.id}` } },
      create: {
        ownerId: input.ownerId,
        clientId: `page:${input.id}`,
        title: input.title,
        format: 'hybrid',
        body: input.content,
      },
      update: {
        title: input.title,
        body: input.content,
        format: 'hybrid',
        deletedAt: null,
        revision: (existing?.revision ?? 0) + 1,
      },
    });
  } catch (error) {
    console.error('[page-sync] CloudDocument mirror failed:', error);
  }
}
