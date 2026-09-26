import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Reorganising the shared resource tree is an admin action.
 *
 * `school_resource_folders` has no owner column, so there is no per-user
 * permission to fall back on: a caller either may rewrite the shared structure
 * or may not. Rename, move and delete shipped behind `getSessionUser()`, which
 * means any signed-in student could rename or move any folder, or delete one
 * and cascade the whole subtree with it -- while `app/api/admin/resources/[id]`
 * already required an admin to touch a single file. Deleting one worksheet was
 * privileged; deleting the structure holding every worksheet was not.
 *
 * Nothing in the UI called either handler, which is exactly why this is
 * source-level: an unreferenced route looks harmless in review and is still
 * fully reachable over HTTP.
 *
 * Creating a folder stays open deliberately -- it is part of uploading, which
 * every signed-in user may do -- so this file asserts the split, not a blanket
 * rule.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MUTATION_ROUTE = 'app/api/school-resource-folders/[id]/route.ts';
const COLLECTION_ROUTE = 'app/api/school-resource-folders/route.ts';

const source = (relative: string) => readFile(join(root, relative), 'utf8');

test('renaming, moving and deleting a folder require an admin', async () => {
  const src = await source(MUTATION_ROUTE);
  assert.doesNotMatch(
    src,
    /getSessionUser/,
    'a plain session is not enough to rewrite the shared tree',
  );
  const handlers = [...src.matchAll(/export async function (PATCH|DELETE)\b/g)].map((m) => m[1]);
  assert.deepEqual(handlers.sort(), ['DELETE', 'PATCH'], 'both mutating handlers must still exist');
  for (const handler of handlers) {
    const start = src.indexOf(`export async function ${handler}`);
    const body = src.slice(start, start + 400);
    assert.match(body, /requireAdmin\(\)/, `${handler} must call requireAdmin()`);
    assert.match(body, /status: 403/, `${handler} must answer 403`);
  }
});

test('the admin check comes before the folder is read or changed', async () => {
  const src = await source(MUTATION_ROUTE);
  for (const handler of ['PATCH', 'DELETE']) {
    const start = src.indexOf(`export async function ${handler}`);
    const body = src.slice(start, src.indexOf('} catch', start));
    const gate = body.indexOf('requireAdmin()');
    const read = body.indexOf('schoolResourceFolder');
    assert.notEqual(gate, -1, `${handler} must have a gate`);
    assert.notEqual(read, -1, `${handler} must still touch the folder`);
    assert.ok(gate < read, `${handler} must refuse before reading or writing the folder`);
  }
});

test('creating a folder stays available to any signed-in user', async () => {
  // The counterpart to the rule above, pinned so a later "make it consistent"
  // pass does not lock students out of uploading into a new folder.
  const src = await source(COLLECTION_ROUTE);
  assert.match(src, /getSessionUser\(\)/, 'creating a folder is part of uploading');
  assert.doesNotMatch(src, /requireAdmin/, 'creating a folder must not need an admin');
});
