import { test, expect } from '@playwright/test';

/**
 * The real `SchoolResourceFolder` tree that replaced the "From folder upload:"
 * string-parsing hack.
 *
 * Driven through the API rather than the upload dialog: a `webkitdirectory`
 * input cannot be filled from Playwright without shipping fixture trees, and
 * the assertions worth guarding -- path resolution reusing folders, attribution
 * and the permission split -- are all server-side.
 *
 * THE PERMISSION MODEL IS DELIBERATE, and these tests exist to hold it still:
 * any signed-in student may CREATE folders and upload into them, because the
 * library belongs to the year group rather than to staff; only an admin may
 * rename, move or delete, so a contributor cannot sabotage the shelf everyone
 * else's work sits on. An earlier version of this file asserted 200 on rename
 * and read as a bug report against that design.
 *
 * Two consequences for the fixtures:
 *  - Nothing here can clean up a folder it made -- DELETE is admin-only and
 *    this suite runs as a student. So the tree is DETERMINISTIC and reused
 *    across runs instead of stamped with Date.now(), which otherwise left a
 *    fresh `e2e root <stamp>` in the shared library every single night.
 *  - Resources still delete cleanly (that route only needs a session), so
 *    those are cleaned up per test as before.
 */
test.describe('school resource folders', () => {
  // These tests leave folders behind in the live library -- see E2E_FOLDER_FIXTURES
  // in .github/workflows/ci.yml for why they cannot tidy up. Skipped unless the
  // run was asked for by a person, so the nightly never litters a shelf students
  // can see. `npm run e2e` locally sets nothing, so set it explicitly:
  //   E2E_FOLDER_FIXTURES=true npm run e2e
  test.skip(
    process.env.E2E_FOLDER_FIXTURES !== 'true',
    'creates folders in the live library that only an admin can remove; run on demand',
  );

  // Reused every run. Path resolution is find-or-create, so the second run
  // lands in the same rows the first one made.
  const ROOT = 'e2e fixtures';
  const created: { resources: string[] } = { resources: [] };

  // A valid resource upload. The UUID shape is required:
  // lib/school-resource-upload.ts 400s anything else, which is a
  // path-traversal guard rather than a formality.
  const FILE = {
    fileUrl: '/uploads/files/00000000-0000-4000-8000-000000000000.txt',
    fileName: 'e2e-placeholder.txt',
    fileSize: 12,
    category: 'notes',
    subject: 'Chemistry',
  };

  test.afterEach(async ({ request }) => {
    for (const id of created.resources.splice(0)) {
      await request.delete(`/api/school-resources/${id}`).catch(() => {});
    }
  });

  test('any signed-in student can create and nest folders', async ({ request }) => {
    const mk = async (name: string, parentId: string | null = null) => {
      const res = await request.post('/api/school-resource-folders', { data: { name, parentId } });
      expect(res.status(), `POST folder ${name}`).toBe(201);
      return (await res.json()).folder as { id: string; createdBy: { id: string; name: string | null } | null };
    };

    const root = await mk(ROOT);
    const mid = await mk('level 2', root.id);
    const leaf = await mk('level 3', mid.id);
    expect(leaf.id).toBeTruthy();

    // Attribution: a folder records who made it, so the library can show a
    // contributor rather than presenting student work as school-issued.
    // Only asserted on the root, which this suite created on its first run --
    // the nested two may have been reused, and reuse deliberately does not
    // overwrite the original contributor.
    expect(root.createdBy, 'the root folder carries a contributor').not.toBeNull();
  });

  test('a student cannot rename, move or delete a folder', async ({ request }) => {
    const res = await request.post('/api/school-resource-folders', { data: { name: ROOT, parentId: null } });
    expect(res.status()).toBe(201);
    const id = (await res.json()).folder.id as string;

    // This is the design, not a gap: contribute freely, cannot sabotage.
    expect((await request.patch(`/api/school-resource-folders/${id}`, { data: { name: 'renamed by a student' } })).status(),
      'rename is admin-only').toBe(403);
    expect((await request.patch(`/api/school-resource-folders/${id}`, { data: { parentId: null } })).status(),
      'move is admin-only').toBe(403);
    expect((await request.delete(`/api/school-resource-folders/${id}`)).status(),
      'delete is admin-only').toBe(403);
  });

  test('a folder path resolves to existing folders instead of duplicating them', async ({ request }) => {
    const folderPath = `${ROOT}/inner`;
    const post = (title: string) =>
      request.post('/api/school-resources', { data: { ...FILE, title, description: 'created by the e2e suite', folderPath } });

    const first = await post('e2e resource A');
    expect(first.status(), 'first upload into a new path').toBe(201);
    const firstBody = (await first.json()).resource as { id: string; folderId: string; description: string };
    created.resources.push(firstBody.id);

    const second = await post('e2e resource B');
    expect(second.status(), 'second upload into the same path').toBe(201);
    const secondBody = (await second.json()).resource as { id: string; folderId: string };
    created.resources.push(secondBody.id);

    // Same path, same folder row -- not a second one with the same name.
    expect(secondBody.folderId, 'the path resolved to the existing folder').toBe(firstBody.folderId);

    // The marker string that used to carry the path is gone for good.
    expect(firstBody.description).not.toContain('From folder upload:');
  });

  test('a folder listing names the contributor of each subfolder', async ({ request }) => {
    await request.post('/api/school-resource-folders', { data: { name: ROOT, parentId: null } });
    const listing = await request.get('/api/school-resources?folderId=');
    expect(listing.status()).toBe(200);
    const folders = (await listing.json()).folders as { name: string; createdBy: unknown }[];
    const root = folders.find((f) => f.name === ROOT);
    expect(root, `${ROOT} is listed at the top level`).toBeTruthy();
    // `createdBy` must be PRESENT as a field even when null -- folders made
    // before attribution shipped legitimately have none, and the UI renders
    // nothing rather than guessing.
    expect(root && 'createdBy' in root, 'the listing carries a createdBy field').toBe(true);
  });

  // Needs an admin storage state, which this suite does not have: deletion is
  // admin-only by design, so a student cannot set the scenario up. The
  // behaviour it guarded -- ON DELETE SET NULL, so a deleted folder does not
  // take a student's file with it -- is asserted instead by the schema and by
  // prisma/migrations/20260928080000_school_resource_folder_creator.
  test.skip('deleting a folder keeps its files, with folderId cleared', async () => {});
});
