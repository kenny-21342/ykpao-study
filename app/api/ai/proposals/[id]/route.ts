import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { applyAIActionProposal, cancelAIActionProposal, toProposalView, updateAIActionProposal } from '@/lib/ai-proposals';
import type { AIActionProposalPayload } from '@/lib/copilot-types';

export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  action: z.enum(['edit', 'confirm', 'cancel']),
  payload: z.record(z.string(), z.unknown()).optional(),
});

async function ownedProposal(userId: string, id: string) {
  return prisma.aIActionProposal.findFirst({ where: { id, ownerId: userId } });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await context.params;
  const proposal = await ownedProposal(user.id, id);
  if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  return NextResponse.json({ proposal: toProposalView(proposal) });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await context.params;
  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid proposal request' }, { status: 400 });
  }
  try {
    if (body.action === 'edit') {
      const proposal = await updateAIActionProposal(user.id, id, (body.payload || {}) as Partial<AIActionProposalPayload>);
      return NextResponse.json({ proposal });
    }
    if (body.action === 'cancel') {
      const proposal = await cancelAIActionProposal(user.id, id);
      return NextResponse.json({ proposal });
    }
    const applied = await applyAIActionProposal(user.id, id);
    const message = await prisma.aIMessage.findFirst({ where: { proposalId: id } });
    if (message) {
      const current = message.actionData && typeof message.actionData === 'object' && !Array.isArray(message.actionData) ? message.actionData as Record<string, unknown> : {};
      await prisma.aIMessage.update({ where: { id: message.id }, data: { actionData: { ...current, proposal: applied.proposal, appliedResult: applied.result } as unknown as Prisma.InputJsonValue } });
    }
    return NextResponse.json(applied);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Proposal could not be updated' }, { status: 409 });
  }
}
