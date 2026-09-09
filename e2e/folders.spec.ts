import { test, expect } from '@playwright/test';

/**
 * The real `SchoolResourceFolder` tree that replaced the "From folder upload:"
 * string-parsing hack.
 *
 * Driven through the API rather than the upload dialog: a `webkitdirectory`
 * input cannot be filled from Playwright without shipping fixture trees, and
 * the assertions worth guarding -- path resolution reusing folders, the cycle
 * guard, and files surviving their folder's deletion -- are all server-side.
 */
test.describe('school resource folders', () => {
  const created: { folders: string[]; resources: string[] } = { folders: [], resources: [] };

  test.afterEach(async ({ request }) => {
    for (const id of created.resources.splice(0)) {
      await request.delete(`/api/school-resources/${id}`).catch(() => {});
    }
    // Children first: a parent delete would orphan the ids we still hold.
    for (const id of created.folders.splice(0).reverse()) {
      await request.delete(`/api/school-resource-folders/${id}`).catch(() => {});
    }
  });

  test('nests, renames, moves, and refuses to make a cycle', async ({ request }) => {
    const stamp = Date.now().toString(36);
    const mk = async (name: string, parentId: string | null = null) => {
      const res = await request.post('/api/school-resource-folders', { data: { name, parentId } });
      expect(res.status(), `POST folder ${name}`).toBe(201);
      const id = (await res.json()).folder.id as string;
      created.folders.push(id);
      return id;
    };

    const root = await mk(`e2e root ${stamp}`);
    const mid = await mk('level 2', root);
    const leaf = await mk('level 3', mid);

    const patch = (id: string, data: Record<string, unknown>) =>
      request.patch(`/api/school-resource-folders/${id}`, { data });

    expect((await patch(mid, { name: 'level 2 renamed' })).status(), 'rename').toBe(200);
    expect((await patch(leaf, { parentId: root })).status(), 'legal move').toBe(200);

    // The two shapes of cycle. Both must be refused, not merely survived.
    expect((await patch(root, { parentId: leaf })).status(), 'move into own descendant').toBe(400);
    expect((await patch(root, { parentId: root })).status(), 'move into itself').toBe(400);
  });

  test('a folder path resolves to existing folders instead of duplicating them', async ({ request }) => {
    const stamp = Date.now().toString(36);
    const folderPath = `e2e path ${stamp}/inner`;

    const post = () =>
      request.post('/api/school-resources', {
        data: {
          title: `e2e resource ${stamp}`,
          description: 'created by the e2e suite',
          subject: 'Chemistry',
          folderPath,
          fileUrl: '/uploads/files/e2e-placeholder.txt',
          fileName: 'e2e-placeholder.txt',
          fileSize: 12,
          category: 'notes',
        },
      });

    const first = await post();
    expect(first.status(), 'first upload into a new path').toBe(201);
    const firstBody = (await first.json()).resource as { id: string; folderId: string; description: string };
    created.resources.push(firstBody.id);

    const second = await post();
    expect(second.status(), 'second upload into the same path').toBe(201);
    const secondBody = (await second.json()).resource as { id: string; folderId: string };
    created.resources.push(secondBody.id);

    // Same path, same folder row -- not a second one with the same name.
    expect(secondBody.folderId, 'the path resolved to the existing folder').toBe(firstBody.folderId);
    created.folders.push(firstBody.folderId);

    // The marker string that used to carry the path is gone for good.
    expect(firstBody.description).not.toContain('From folder upload:');
  });

  test('deleting a folder keeps its files, with folderId cleared', async ({ request }) => {
    const stamp = Date.now().toString(36);
    const folder = await request.post('/api/school-resource-folders', {
      data: { name: `e2e doomed ${stamp}`, parentId: null },
    });
    expect(folder.status()).toBe(201);
    const folderId = (await folder.json()).folder.id as string;

    const resource = await request.post('/api/school-resources', {
      data: {
        title: `e2e survivor ${stamp}`,
        subject: 'Chemistry',
        folderPath: `e2e doomed ${stamp}`,
        fileUrl: '/uploads/files/e2e-placeholder.txt',
        fileName: 'e2e-placeholder.txt',
        fileSize: 12,
        category: 'notes',
      },
    });
    expect(resource.status()).toBe(201);
    const resourceId = (await resource.json()).resource.id as string;
    created.resources.push(resourceId);

    expect((await request.delete(`/api/school-resource-folders/${folderId}`)).status()).toBe(200);

    // ON DELETE SET NULL: the file is not collateral damage, it moves to root.
    const rootListing = await request.get('/api/school-resources?folderId=');
    expect(rootListing.status()).toBe(200);
    const listed = (await rootListing.json()).resources as { id: string }[];
    expect(listed.some((row) => row.id === resourceId), 'the file survived at root level').toBe(true);
  });
});
