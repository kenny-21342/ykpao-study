import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

test('no surface claims an upload came from "Staff"', () => {
  // The library is open to every signed-in student, so a hardcoded "Staff"
  // fallback presented a classmate's work as school-issued.
  const roots = ['app/components', 'app/admin'];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && !rel.endsWith('ui/Contributor.tsx')) {
        if (/\?\?\s*'Staff'|\?\?\s*"Staff"/.test(read(rel))) offenders.push(rel);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [], 'these fall back to "Staff" instead of the real contributor');
});

test('a folder created by someone is attributed to them, and a reused one is not', () => {
  const src = read('lib/school-resource-folders.ts');
  assert.ok(/createdById: string \| null = null/.test(src), 'createdById must be an argument');
  // The create path writes it...
  assert.ok(/data: \{ name, parentId, createdById \}/.test(src), 'a new folder records its creator');
  // ...and the reuse path must return before that, so a later uploader
  // cannot take credit for a folder someone else made.
  const existingReturn = src.indexOf('if (existing) return existing.id;');
  const createCall = src.indexOf('data: { name, parentId, createdById }');
  assert.ok(existingReturn > -1 && existingReturn < createCall,
    'reusing an existing folder must short-circuit before the attributed create');
});

test('the folder listing returns its contributor', () => {
  const src = read('app/api/school-resources/route.ts');
  assert.ok(/createdBy: \{ select: \{ id: true, name: true, image: true \} \}/.test(src),
    'the folder query must select createdBy');
  assert.ok(/createdBy: c\.createdBy/.test(src), 'and pass it through to the response');
});

test('Contributor renders nothing rather than guessing', () => {
  const src = read('app/components/ui/Contributor.tsx');
  assert.ok(/if \(!user\) return null;/.test(src),
    'a folder predating attribution has no true answer and must render blank');
});
