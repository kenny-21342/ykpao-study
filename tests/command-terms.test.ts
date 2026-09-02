import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMMAND_TERMS,
  COMMAND_TERM_SLUGS,
  commandTerm,
  commandTermLabel,
  extractCommandTerms,
} from '../lib/command-terms.ts';

/** The slugs tag.py's COMMAND_WORDS actually contains, read from the source. */
function slugsFromTagPy(): Set<string> {
  const source = readFileSync(
    new URL('../pdf_extraction/bank/tag.py', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('COMMAND_WORDS: set[str] = {');
  assert.notEqual(start, -1, 'COMMAND_WORDS literal not found in tag.py');
  const end = source.indexOf('}', start);
  const body = source.slice(start, end);
  return new Set(Array.from(body.matchAll(/"([a-z]+)"/g), (m) => m[1]));
}

test('the TypeScript port covers exactly tag.py COMMAND_WORDS', () => {
  const fromPython = slugsFromTagPy();
  // Guards against the regex above silently matching nothing.
  assert.ok(fromPython.size > 30, `only found ${fromPython.size} words in tag.py`);

  const missing = [...fromPython].filter((slug) => !COMMAND_TERM_SLUGS.has(slug));
  const extra = [...COMMAND_TERM_SLUGS].filter((slug) => !fromPython.has(slug));
  assert.deepEqual(missing, [], 'command words in tag.py with no entry here');
  assert.deepEqual(extra, [], 'entries here that tag.py would never produce');
});

test('every term carries a label, a band and guidance', () => {
  for (const term of COMMAND_TERMS) {
    assert.equal(term.slug, term.slug.toLowerCase());
    assert.ok(term.label.length > 0, `${term.slug} has no label`);
    assert.ok(['recall', 'procedure', 'higher'].includes(term.band));
    assert.ok(term.guidance.length > 20, `${term.slug} guidance is too thin`);
  }
});

test('slugs are unique', () => {
  assert.equal(COMMAND_TERM_SLUGS.size, COMMAND_TERMS.length);
});

test('extraction returns terms in order of first appearance, de-duplicated', () => {
  assert.deepEqual(
    extractCommandTerms('Calculate the mean, then explain your answer and calculate the range.'),
    ['calculate', 'explain'],
  );
});

test('extraction is case-insensitive', () => {
  assert.deepEqual(extractCommandTerms('STATE the formula.'), ['state']);
});

test('extraction respects word boundaries', () => {
  // "given" is not "give"; "shows" is not "show"; "statement" is not "state".
  assert.deepEqual(extractCommandTerms('Given the statement, the graph shows a peak.'), []);
});

test('extraction ignores empty and non-string-ish input', () => {
  assert.deepEqual(extractCommandTerms(''), []);
  assert.deepEqual(extractCommandTerms('   \n  '), []);
});

test('a multi-part question yields every distinct term it uses', () => {
  const body = [
    '(a) Define kinetic energy.',
    '(b) Calculate the speed of the trolley at B.',
    '(c) Explain why the answer to (b) is smaller than the theoretical value.',
    '(d) Suggest one improvement to the experiment.',
  ].join('\n');
  assert.deepEqual(extractCommandTerms(body), ['define', 'calculate', 'explain', 'suggest']);
});

test('lookup helpers are tolerant of surrounding whitespace and case', () => {
  assert.equal(commandTerm('  Evaluate ')?.slug, 'evaluate');
  assert.equal(commandTermLabel('describe'), 'Describe');
  assert.equal(commandTerm('ponder'), null);
  // An unknown slug renders as itself rather than blank.
  assert.equal(commandTermLabel('ponder'), 'ponder');
});

test('evaluate guidance names both readings, since the mark schemes differ', () => {
  const guidance = commandTerm('evaluate')!.guidance.toLowerCase();
  assert.ok(guidance.includes('maths'));
  assert.ok(guidance.includes('judgement'));
});
