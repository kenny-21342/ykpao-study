import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Which corpus a predicted paper is built from.
 *
 * `past_paper_questions` carries question text and has real depth for the IB
 * subjects; the crop-first bank has 66,756 published questions and `bodyMd`
 * empty on every one of them. So a model can curate the first and can read
 * nothing of the second, and "Generate Predicted Paper" has to pick a path by
 * what the data supports rather than by preference.
 *
 * Before this split the feature only ever queried the legacy table, which for
 * Additional Mathematics holds 0 usable questions across 140 papers — the
 * generation simply threw, for every CAIE subject a student could choose.
 *
 * These assertions are source-level for the same reason the size-invariant
 * ones are: the failure mode is someone reintroducing a model call or a legacy
 * table read into the bank path, which no test of the current behaviour would
 * catch without a database.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREDICTED = 'lib/predicted-paper.ts';
const SELECTION = 'lib/mock-exam-selection.ts';
const SUBJECTS_ROUTE = 'app/api/mock-exams/subjects/route.ts';

async function source(relative: string): Promise<string> {
  return readFile(join(root, relative), 'utf8');
}

/** The body of a named top-level async function, by brace matching. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in the source`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

test('the corpus is chosen before a blueprint is attempted', async () => {
  const src = await source(PREDICTED);
  const body = functionBody(src, 'createPredictedPaper');
  const decisionAt = body.indexOf('predictionPathsFor(');
  const blueprintAt = body.indexOf('buildBlueprint(');
  assert.notEqual(decisionAt, -1, 'the path must be decided');
  assert.notEqual(blueprintAt, -1, 'the legacy blueprint call must still exist');
  assert.ok(
    decisionAt < blueprintAt,
    'the path must be chosen before buildBlueprint, which throws when the legacy table is empty',
  );
});

test('a thin legacy subject is routed to the bank', async () => {
  const src = await source(PREDICTED);
  const body = functionBody(src, 'createPredictedPaper');
  assert.match(body, /predictionPathsFor\(/);
  assert.match(body, /createBankPredictedPaper\(/);
  assert.match(body, /toBankSubjectCodes\(/);
});

test('the routing rule consults both corpora, not just the legacy count', async () => {
  const src = await source(PREDICTED);
  const body = functionBody(src, 'predictionPathsFor');
  assert.match(body, /MIN_LEGACY_CANDIDATES/);
  assert.match(
    body,
    /listServableSubjects\(/,
    'Mathematics has 55 legacy questions and no bank marks at all; routing on the legacy count alone sends it to a corpus that cannot serve it',
  );
});

test('one rule serves both the form and the generator', async () => {
  const predicted = await source(PREDICTED);
  const route = await source(SUBJECTS_ROUTE);
  assert.match(predicted, /export async function predictionPathsFor/);
  assert.match(
    route,
    /predictionPathsFor\(/,
    'the form must ask the same function the generator routes on, or it will offer inert controls',
  );
});

test('a bank paper that cannot be filled falls through instead of throwing', async () => {
  const src = await source(PREDICTED);
  assert.match(
    src,
    /Promise<PredictedPaperResult \| null>/,
    'the bank path must be able to decline so the legacy corpus still gets a try',
  );
  const body = functionBody(src, 'createPredictedPaper');
  assert.match(body, /if \(assembled\) return assembled;/);
});

test('the bank path asks no model anything', async () => {
  const src = await source(PREDICTED);
  const body = functionBody(src, 'createBankPredictedPaper');
  assert.doesNotMatch(
    body,
    /chatJSON|chat\(/,
    'the bank has no question text, so a model call here spends money to reorder a list it cannot read',
  );
  assert.doesNotMatch(
    body,
    /credential/,
    'nothing in the bank path should need a paid credential',
  );
});

test('the bank path never reads the legacy tables', async () => {
  const src = await source(PREDICTED);
  for (const name of ['createBankPredictedPaper', 'buildBankBlueprint']) {
    const body = functionBody(src, name);
    assert.doesNotMatch(
      body,
      /prisma\.pastPaper|past_paper_questions|prisma\.subject\b/,
      `${name} must not fall back to the corpus it exists to replace`,
    );
  }
});

test('bank-backed items are stored against the bank, not the legacy question table', async () => {
  const src = await source(PREDICTED);
  const body = functionBody(src, 'createBankPredictedPaper');
  assert.match(body, /bankQuestionId:/);
  assert.doesNotMatch(
    body,
    /\bquestionId:/,
    'a MockExamItem pointing at past_paper_questions would dangle for bank questions',
  );
});

test('a predicted paper is shaped after one paper number', async () => {
  const predicted = await source(PREDICTED);
  const body = functionBody(predicted, 'createBankPredictedPaper');
  assert.match(
    body,
    /paperNumber:\s*blueprint\.paperNumber/,
    'the draw must be restricted to the paper number the blueprint just described',
  );

  const selection = await source(SELECTION);
  assert.match(
    selection,
    /AND p\."paperNumber" = \$\{paperNumber\}/,
    'selectBankQuestions must be able to restrict the draw by paper number',
  );
  assert.match(
    selection,
    /paperNumber\?:\s*number \| null/,
    'the filter must stay optional so mock generation is unaffected',
  );
});

test('the bank blueprint claims only what the bank can support', async () => {
  const src = await source(PREDICTED);
  const body = functionBody(src, 'createBankPredictedPaper');
  // bank_topics has no rows and no published question carries a difficulty, so
  // a topic breakdown here would be invented.
  assert.match(body, /syllabusCoverage:\s*\[\]/);
  assert.match(body, /markSchemeGuide:\s*\[\]/);
  assert.match(
    body,
    /confidence:\s*'medium'/,
    "a paper assembled without reading a question should not report 'high'",
  );
});
