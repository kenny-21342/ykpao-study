import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dedupeSearchResults, resultIdentity } from '../lib/search-dedupe.ts';

test('the same mark scheme under four record ids collapses to one row', () => {
  // The real shape: four distinct past-paper questions, same rendered title.
  const rows = [21346, 21449, 21555, 21660].map((id) => ({
    id: `markscheme-${id}`,
    type: 'markscheme',
    title: 'ib-chemistry 2017 may Paper 2 Q4 mark scheme',
    url: `/?tab=practice&bqid=${id}`,
  }));
  const out = dedupeSearchResults(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'markscheme-21346', 'the first (highest ranked) row survives');
});

test('different titles of the same type are both kept', () => {
  const out = dedupeSearchResults([
    { type: 'markscheme', title: 'Q4 mark scheme' },
    { type: 'markscheme', title: 'Q5 mark scheme' },
  ]);
  assert.equal(out.length, 2);
});

test('the same title under different types is not collapsed', () => {
  const out = dedupeSearchResults([
    { type: 'question', title: 'Hydrogen bonding' },
    { type: 'markscheme', title: 'Hydrogen bonding' },
  ]);
  assert.equal(out.length, 2, 'a question and its mark scheme are different things');
});

test('identity ignores case and runs of whitespace', () => {
  assert.equal(
    resultIdentity({ type: 'question', title: '  Hydrogen   Bonding ' }),
    resultIdentity({ type: 'question', title: 'hydrogen bonding' }),
  );
});

test('order is preserved so the ranked block still leads', () => {
  const out = dedupeSearchResults([
    { type: 'question', title: 'A' },
    { type: 'question', title: 'B' },
    { type: 'question', title: 'A' },
    { type: 'question', title: 'C' },
  ]);
  assert.deepEqual(out.map((r) => r.title), ['A', 'B', 'C']);
});

test('the search route de-duplicates before it responds', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'app/api/search/route.ts'), 'utf8');
  assert.ok(
    /const results = dedupeSearchResults\(assembled\)/.test(src),
    'route.ts must pass the assembled rows through dedupeSearchResults',
  );
  const responds = src.indexOf('NextResponse.json({ results, query');
  const dedupes = src.indexOf('dedupeSearchResults(assembled)');
  assert.ok(dedupes > -1 && dedupes < responds, 'de-duplication must happen before the response');
});
