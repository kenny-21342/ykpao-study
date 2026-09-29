import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchTerms } from '../lib/rag-terms.ts';

/**
 * The bug these pin: asking "What should I study today?" produced an Evidence
 * panel citing an IB Psychology question ("Describe one study related to one
 * model of memory") and two 0607 maths questions ("Each student studies at
 * least one of the sciences"). The lexical matcher takes any single term, and
 * `study` was a term, so the word in the question text was the whole reason
 * those sources were shown for a question about scheduling.
 */

test('a purely scheduling question yields no search terms', () => {
  assert.deepEqual(searchTerms('What should I study today?'), []);
  assert.deepEqual(searchTerms('what should i do next'), []);
  assert.deepEqual(searchTerms('Any suggestions for this week?'), []);
  assert.deepEqual(searchTerms('give me a revision plan'), []);
});

test('"study" is kept when the query also names real subject matter', () => {
  // The IB Psychology phrasing that made a blanket stop word the wrong fix.
  const terms = searchTerms('Describe one study related to one model of memory');
  assert.ok(terms.includes('memory'), 'content terms survive');
  assert.ok(terms.includes('model'));
  // ...but the meta word itself is dropped, which is the precision win.
  assert.ok(!terms.includes('study'));
});

test('ordinary content questions are unaffected', () => {
  assert.deepEqual(searchTerms('explain osmosis in plant cells'), ['osmosis', 'plant', 'cells']);
  assert.deepEqual(searchTerms('newton second law'), ['newton', 'second', 'law']);
});

test('existing stop words are still removed', () => {
  assert.deepEqual(searchTerms('what is photosynthesis'), ['photosynthesis']);
});

test('short tokens and punctuation are dropped', () => {
  assert.deepEqual(searchTerms('pH of HCl?'), ['hcl']);
});

test('no more than six terms are searched', () => {
  assert.equal(searchTerms('osmosis diffusion mitosis meiosis enzymes proteins carbohydrates lipids').length, 6);
});

test('an empty or meaningless query yields nothing rather than the raw string', () => {
  // The old implementation fell back to `[query]`, which turned a query with
  // no usable terms into a literal substring match.
  assert.deepEqual(searchTerms(''), []);
  assert.deepEqual(searchTerms('?? !!'), []);
});

test('a discovery request keeps its subject', () => {
  assert.deepEqual(searchTerms('show me notes on osmosis'), ['notes', 'osmosis']);
  assert.deepEqual(searchTerms('find past paper questions about electrolysis'), ['past', 'paper', 'questions', 'electrolysis']);
});

test('the 0607 phrasing that was wrongly cited yields no overlap with a scheduling query', () => {
  const cited = searchTerms('Each student studies at least one of the sciences');
  const asked = searchTerms('What should I study today?');
  assert.deepEqual(asked, []);
  // The citation happened because both sides shared `study`; the corpus side
  // keeps its real terms, but there is now nothing on the query side to match.
  assert.ok(cited.includes('sciences'));
  assert.ok(!cited.includes('studies'));
});
