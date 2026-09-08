/**
 * Merge each page's PageYjsUpdate log into its PageYjsSnapshot, then prune
 * the updates that are now folded in.
 *
 * Feature 5 (Yjs collaborative editing) is additive and flagged off by
 * default (YJS_COLLAB=on to enable) -- see lib/stream-config.ts. This script
 * only touches pages that actually have Yjs update rows, which is none of
 * them while the flag stays off everywhere, so running it on a schedule is
 * harmless even before anyone opts in.
 *
 * A joining client reconstructs a page's live document by applying the
 * snapshot (if any) followed by every update after it -- see
 * GET /api/pages/[id]/yjs-updates. Without compaction that log only grows,
 * and a long-running collaborative page would eventually make every join
 * replay its entire edit history. Applying/re-encoding Yjs updates is pure
 * CRDT math (no ProseMirror involved), so it's safe to run here even before
 * the ProseMirror <-> Yjs binding itself is wired up client-side.
 *
 * Usage:
 *   npx tsx scripts/compact-page-yjs-updates.ts               # dry run, report only
 *   npx tsx scripts/compact-page-yjs-updates.ts --apply
 */
import 'dotenv/config';
import * as Y from 'yjs';
import { prisma } from '../lib/prisma';

// Below this, replaying the raw log costs a joining client almost nothing --
// not worth a write to compact it yet.
const MIN_UPDATES_TO_COMPACT = 20;

async function main() {
  const apply = process.argv.includes('--apply');

  const pageIds = await prisma.pageYjsUpdate.findMany({
    distinct: ['pageId'],
    select: { pageId: true },
  });

  let compacted = 0;
  let prunedUpdates = 0;

  for (const { pageId } of pageIds) {
    const updates = await prisma.pageYjsUpdate.findMany({
      where: { pageId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, data: true, createdAt: true },
    });
    if (updates.length < MIN_UPDATES_TO_COMPACT) continue;

    const existingSnapshot = await prisma.pageYjsSnapshot.findUnique({
      where: { pageId },
      select: { state: true },
    });

    const doc = new Y.Doc();
    if (existingSnapshot) Y.applyUpdate(doc, new Uint8Array(existingSnapshot.state));
    for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update.data));
    // Prisma 7's Bytes fields are typed as Uint8Array<ArrayBuffer>, narrower
    // than what Y.encodeStateAsUpdate returns -- copy into a plain Uint8Array.
    const mergedState = new Uint8Array(Y.encodeStateAsUpdate(doc));
    doc.destroy();

    const lastUpdateAt = updates[updates.length - 1].createdAt;
    console.log(
      `[page ${pageId}] folding ${updates.length} updates (oldest ${updates[0].createdAt.toISOString()}, ` +
        `newest ${lastUpdateAt.toISOString()}) into a ${mergedState.byteLength}-byte snapshot`
    );

    if (apply) {
      await prisma.$transaction([
        prisma.pageYjsSnapshot.upsert({
          where: { pageId },
          create: { pageId, state: mergedState },
          update: { state: mergedState },
        }),
        // Only the rows just folded in -- not `pageId`'s whole log -- so an
        // update written between this read and this write (a live editor
        // mid-session) is never dropped out from under it.
        prisma.pageYjsUpdate.deleteMany({
          where: { pageId, id: { in: updates.map((u) => u.id) } },
        }),
      ]);
    }

    compacted += 1;
    prunedUpdates += updates.length;
  }

  console.log(
    apply
      ? `Compacted ${compacted} page(s), folding and pruning ${prunedUpdates} update rows.`
      : `Dry run: would compact ${compacted} page(s), folding ${prunedUpdates} update rows. Pass --apply to write.`
  );
}

main()
  .catch((error) => {
    console.error('Yjs update compaction failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
