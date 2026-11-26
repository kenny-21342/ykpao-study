import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  graderGuidance,
  graderMaxTokens,
  isIbEconomics,
  nearestExemplar,
  setExemplarsForTest,
} from '../lib/subject-guidance.ts';

const EXEMPLARS = [
  { question: 'Using real-world examples, discuss the consequences of a price ceiling [15 marks]', notes: 'Maximum price set below equilibrium creates a shortage. Rent control in Berlin. [diagram] '.repeat(5) },
  { question: 'Using real world examples, evaluate two government policies to reduce inflation. [15 marks]', notes: 'Contractionary monetary policy raises interest rates; supply-side policies. '.repeat(5) },
];

test('recognises IB economics but not CAIE economics or other subjects', () => {
  assert.equal(isIbEconomics('ib-economics'), true);
  assert.equal(isIbEconomics('Economics'), true);
  assert.equal(isIbEconomics('9708 Economics'), false);
  assert.equal(isIbEconomics('ib-physics'), false);
  assert.equal(isIbEconomics(null), false);
});

test('other subjects get no guidance', () => {
  assert.equal(graderGuidance({ subject: 'ib-physics', marks: 15, questionText: 'Discuss.' }), '');
});

test('short economics items get the rules but not the essay model-answer instruction', () => {
  setExemplarsForTest(EXEMPLARS);
  const text = graderGuidance({ subject: 'ib-economics', marks: 2, questionText: 'Calculate the price elasticity of demand.' });
  assert.match(text, /Own figure rule/);
  assert.doesNotMatch(text, /MODEL ANSWER FOR THIS ITEM/);
  assert.doesNotMatch(text, /TEACHER'S REVISION NOTES/);
});

test('an essay gets the full-answer instruction and the nearest teacher notes', () => {
  setExemplarsForTest(EXEMPLARS);
  const text = graderGuidance({
    subject: 'ib-economics',
    marks: 25,
    questionText: '(b) Using real-world examples, discuss the consequences of a price ceiling on rented housing. [15]',
  });
  assert.match(text, /MODEL ANSWER FOR THIS ITEM/);
  assert.match(text, /price ceiling \[15 marks\]/);
  assert.match(text, /Rent control in Berlin/);
});

test('no exemplar is forced onto an unrelated question', () => {
  setExemplarsForTest(EXEMPLARS);
  assert.equal(nearestExemplar('Explain the role of the World Trade Organization in trade disputes.'), null);
});

test('missing exemplar file degrades to rules only', () => {
  setExemplarsForTest([]);
  const text = graderGuidance({ subject: 'ib-economics', marks: 15, questionText: 'Discuss a price ceiling.' });
  assert.match(text, /MODEL ANSWER FOR THIS ITEM/);
  assert.doesNotMatch(text, /TEACHER'S REVISION NOTES/);
});

test('extended items in any subject get room to reason and answer', () => {
  assert.equal(graderMaxTokens({ subject: 'ib-physics', marks: 3 }, 1200), 1200);
  assert.equal(graderMaxTokens({ subject: 'ib-history', marks: 15 }, 1200), 4000);
  assert.equal(graderMaxTokens({ subject: 'ib-economics', marks: 25 }, 1200), 6000);
});
