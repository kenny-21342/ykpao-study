/**
 * Phase 4 verification: exercises the notebooks → sections → pages → save
 * chain directly against Prisma (mirrors what the API routes do), then cleans up.
 *
 * Run with:  npx tsx scripts/verify-note-taking.ts
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';

async function main() {
  // Use the first available user (verification only — no real auth here)
  const user = await prisma.user.findFirst({ select: { id: true, email: true } });
  if (!user) {
        console.error('✗ No user found in the database. Cannot verify note-taking flow.');
    process.exit(1);
  }
  console.log(`Using user: ${user.email} (${user.id})\n`);

  const created: { notebookId?: string; sectionId?: string; pageId?: string } = {};

  try {
    // 1. Create a notebook
    const notebook = await prisma.notebook.create({
      data: {
        userId: user.id,
        name: '__verify__ Test Notebook',
        color: '#22c55e',
        icon: '🧪',
      },
      include: { sections: { include: { pages: true } } },
    });
    created.notebookId = notebook.id;
    console.log(`✓ Created notebook: ${notebook.id} (sections: ${notebook.sections.length})`);

    // 2. Create a section (ownership scoping works because notebook.userId === user.id)
    const maxOrder = await prisma.section.findFirst({
      where: { notebookId: notebook.id },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const section = await prisma.section.create({
      data: {
        notebookId: notebook.id,
        name: '__verify__ Section A',
        order: (maxOrder?.order ?? -1) + 1,
      },
      include: { pages: true },
    });
    created.sectionId = section.id;
    console.log(`✓ Created section: ${section.id} (pages: ${section.pages.length})`);

    // 3. Create a page
    const pageMax = await prisma.page.findFirst({
      where: { sectionId: section.id },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const page = await prisma.page.create({
      data: {
        sectionId: section.id,
        title: '__verify__ Untitled page',
        content: '',
        order: (pageMax?.order ?? -1) + 1,
      },
    });
    created.pageId = page.id;
    console.log(`✓ Created page: ${page.id} (title: "${page.title}", content empty: ${page.content === ''})`);

    // 4. Save (PATCH semantics) — update title + content
    const saved = await prisma.page.update({
      where: { id: page.id },
      data: {
        title: '__verify__ Mechanics — Newton\'s Laws',
        content: '## Newton\\\'s Second Law\n\n$F = ma$\n\nThe acceleration of an object is proportional to the net force.',
        updatedAt: new Date(),
      },
    });
    const roundtripOk =
      saved.title.includes("Newton's Laws") &&
      saved.content.includes('$F = ma$');
    console.log(`✓ Saved page: title="${saved.title}", content length=${saved.content.length}, roundtrip ok: ${roundtripOk}`);
    if (!roundtripOk) throw new Error('Content roundtrip failed');

    // 5. Re-read the full hierarchy as the GET /api/notebooks route does
    const reloaded = await prisma.notebook.findFirst({
      where: { id: notebook.id, userId: user.id },
      include: {
        sections: {
          include: { pages: { orderBy: { order: 'asc' } } },
          orderBy: { order: 'asc' },
        },
      },
    });
    const hierarchyOk =
      !!reloaded &&
      reloaded.sections.length === 1 &&
      reloaded.sections[0].id === section.id &&
      reloaded.sections[0].pages.length === 1 &&
      reloaded.sections[0].pages[0].id === page.id &&
      reloaded.sections[0].pages[0].content === saved.content;
    console.log(`✓ Hierarchy reload ok: ${hierarchyOk}`);
    if (!hierarchyOk) throw new Error('Hierarchy reload mismatch');

    // 6. Ownership isolation check: a DIFFERENT user must NOT see this notebook
    const otherUser = await prisma.user.findFirst({
      where: { NOT: { id: user.id } },
      select: { id: true },
    });
    if (otherUser) {
      const crossAccess = await prisma.notebook.findFirst({
        where: { id: notebook.id, userId: otherUser.id },
        select: { id: true },
      });
      console.log(`✓ Ownership isolation (other user sees it): ${crossAccess !== null} (expected false)`);
      if (crossAccess) throw new Error('Ownership isolation failed');
    } else {
      console.log('  (only one user in DB — skipping cross-user isolation check)');
    }

    // 7. Page ownership via section→notebook chain (mirrors the PATCH guard)
    const pageGuard = await prisma.page.findFirst({
      where: { id: page.id, section: { notebook: { userId: user.id } } },
      select: { id: true },
    });
    console.log(`✓ Page ownership guard passes for owner: ${pageGuard !== null} (expected true)`);
    if (!pageGuard) throw new Error('Page ownership guard failed');

    console.log('\n✅ ALL CHECKS PASSED — note-taking flow verified end-to-end.');
  } finally {
    // Cleanup (cascade deletes sections + pages)
    if (created.notebookId) {
      await prisma.notebook.deleteMany({ where: { id: created.notebookId } });
      console.log(`\n_cleanup: deleted notebook ${created.notebookId} (cascaded)`);
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n✗ VERIFICATION FAILED:', err);
  process.exit(1);
});
