/**
 * Deleting a page is three things, not one: the row, the cloud mirror that
 * `syncPageToCloud` keeps for iPad sync, and the page's document in the RAG
 * index.
 *
 * The database cascades handle the first when a *section* or *notebook* goes
 * (Page -> Section -> Notebook are all `onDelete: Cascade`), but a cascade
 * cannot know about the other two. Without this helper, deleting a notebook
 * would leave every page inside it searchable -- the same defect that had
 * moderated discussion threads staying in global search.
 */
import { prisma } from './prisma';
import { indexPage, refreshRagIndex } from './rag-index';

/**
 * Tidy up everything that lives outside the `pages` table for the given pages.
 *
 * Call this *before* the delete that removes them: `indexPage` decides to drop
 * a document by looking the page up and finding nothing, so it is run after
 * the rows are gone -- but the ids have to be collected while they still are.
 */
export async function purgePageSideEffects(pages: { id: string; ownerId: string }[]) {
  if (pages.length === 0) return;

  await prisma.cloudDocument.updateMany({
    where: { OR: pages.map((page) => ({ ownerId: page.ownerId, clientId: `page:${page.id}` })) },
    data: { deletedAt: new Date() },
  });

  // Sequential rather than Promise.all: a notebook can hold a lot of pages,
  // and this runs inside a request that has a wall-clock ceiling. One slow
  // index write should not multiply into a burst against the same table.
  for (const page of pages) {
    await refreshRagIndex(`page:${page.id}`, () => indexPage(page.id));
  }
}

/** Every page under a notebook, with the notebook's owner. */
export async function pagesInNotebook(notebookId: string, ownerId: string) {
  const rows = await prisma.page.findMany({
    where: { section: { notebookId } },
    select: { id: true },
  });
  return rows.map((row) => ({ id: row.id, ownerId }));
}

/** Every page under a section, with the owning notebook's user. */
export async function pagesInSection(sectionId: string, ownerId: string) {
  const rows = await prisma.page.findMany({
    where: { sectionId },
    select: { id: true },
  });
  return rows.map((row) => ({ id: row.id, ownerId }));
}
