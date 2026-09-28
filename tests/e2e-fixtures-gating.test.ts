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
  assert.ok(
    /E2E_FOLDER_FIXTURES: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/.test(ci),
    'CI must set it only for a manual dispatch, never for the schedule',
  );
  // The guard is worthless if the schedule can also satisfy it.
  assert.ok(
    !/E2E_FOLDER_FIXTURES:[^\n]*schedule/.test(ci),
    'the scheduled event must not enable folder fixtures',
  );
});
