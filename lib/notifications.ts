import { prisma } from '@/lib/prisma';

/**
 * Create one or more notifications. Best-effort — failures are logged but
 * never propagate to the caller (a notification failure should not break
 * the user action that triggered it, e.g. posting a reply).
 *
 * `recipientIds` must already exclude the actor (no self-notifications).
 */
export async function createNotifications(
  recipients: Array<{
    userId: string;
    actorId: string;
    type: string;
    entityId?: string | null;
    entityUrl?: string | null;
    title: string;
    body?: string;
  }>
) {
  if (recipients.length === 0) return;
  try {
    await prisma.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.userId,
        actorId: r.actorId,
        type: r.type,
        entityId: r.entityId ?? null,
        entityUrl: r.entityUrl ?? null,
        title: r.title,
        body: r.body ?? '',
      })),
    });
  } catch (err) {
    console.error('[notifications] failed to create:', err);
  }
}
