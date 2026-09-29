import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('the folder specs only run when a person asks for them', () => {
  // They create folders in the live resource library and cannot delete them:
  // folder deletion is admin-only by design and the suite runs as a student.
  // On the nightly schedule that left test scaffolding in a shelf the whole
  // year group can see.
  const spec = read('e2e/folders.spec.ts');
  assert.ok(
    /test\.skip\(\s*process\.env\.E2E_FOLDER_FIXTURES !== 'true'/.test(spec),
    'folders.spec.ts must skip unless E2E_FOLDER_FIXTURES is exactly "true"',
  );

  const ci = read('.github/workflows/ci.yml');
  // The ask is the checkbox on the Run workflow button, not the mere fact of
  // dispatching. Keying it to `github.event_name` made the only by-hand run
  // also the one that dirtied production, so a red nightly could not be
  // re-checked without leaving litter behind.
  assert.ok(
    /E2E_FOLDER_FIXTURES: \$\{\{ inputs\.folder_fixtures == true \}\}/.test(ci),
    'CI must take folder fixtures from an explicit dispatch input',
  );
  // That input has to default to off, or the safer spelling buys nothing.
  assert.match(
    ci,
    /folder_fixtures:\s*\n\s*description:[^\n]*\n\s*type: boolean\n\s*default: false/,
    'the folder_fixtures input must be declared boolean and default to false',
  );
  // The guard is worthless if the schedule or a push can also satisfy it.
  assert.ok(
    !/E2E_FOLDER_FIXTURES:[^\n]*(schedule|event_name)/.test(ci),
    'no event type may enable folder fixtures on its own',
  );
});
