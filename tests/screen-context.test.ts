import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeScreenContext,
  DEFAULT_SCREEN_CONTEXT,
  type ScreenContext,
} from '../lib/screen-context.ts';

/**
 * What the AI tutor is told about the screen.
 *
 * Before this was wired, three of eight surfaces reported anything: the tutor
 * knew the tab label and nothing else, so a student looking at a specific
 * past-paper question and asking "how do I do this one?" gave it the word
 * "Practice" to work from. The bank -- the corpus students actually open --
 * reported nothing at all.
 *
 * Two of the lines below are safety rules rather than context, and both are
 * the kind of thing a tidy-up deletes:
 *
 *  - A question with no transcript must be declared unreadable. 1,184 of the
 *    66,756 published questions exist only as image crops, and the tutor
 *    cannot see images here. Silence invites it to invent the wording.
 *  - A paper still in progress must carry the do-not-answer instruction.
 *    The exam route deliberately sends option letters without the key; a
 *    tutor that answers the question in the sidebar hands back what the
 *    server just withheld.
 */

const ctx = (data: ScreenContext['data'], over: Partial<ScreenContext> = {}): ScreenContext => ({
  ...DEFAULT_SCREEN_CONTEXT,
  description: 'Practice',
  ...over,
  data,
});

test('the section description is always present', () => {
  assert.match(serializeScreenContext(ctx({})), /^Section: Practice$/m);
});

test('a bank question is identified by paper, number and command terms', () => {
  const out = serializeScreenContext(ctx({
    bankQuestionId: 47552,
    bankPaperReference: '0625 2024 s Paper 4 Variant 1 Q7',
    bankCommandTerms: ['calculate', 'explain'],
    bankHasText: true,
    subjectCode: '0625',
  }));
  assert.match(out, /Viewing past-paper question: 0625 2024 s Paper 4 Variant 1 Q7/);
  assert.match(out, /Command terms: calculate, explain/);
  assert.match(out, /Subject: 0625/);
});

test('an untranscribed question is declared unreadable rather than left silent', () => {
  const out = serializeScreenContext(ctx({
    bankPaperReference: '0620 2019 w Paper 2 Variant 1 Q3',
    bankHasText: false,
  }));
  assert.match(out, /has not been transcribed/);
  assert.match(out, /rather than guessing/);
});

test('a transcribed question carries no such warning', () => {
  const out = serializeScreenContext(ctx({
    bankPaperReference: '0620 2019 w Paper 2 Variant 1 Q3',
    bankHasText: true,
  }));
  assert.doesNotMatch(out, /has not been transcribed/);
});

test('a live exam tells the tutor not to answer it', () => {
  const out = serializeScreenContext(ctx({
    examTitle: 'Physics mock 3',
    examItemPosition: 'question 3 of 12',
    examItemMarks: 6,
    examSubmitted: false,
  }));
  assert.match(out, /Sitting mock exam: "Physics mock 3" — question 3 of 12/);
  assert.match(out, /worth 6 marks/);
  assert.match(out, /Do not give the answer/);
});

test('a submitted exam is a review, so the refusal is dropped', () => {
  const out = serializeScreenContext(ctx({
    examTitle: 'Physics mock 3',
    examSubmitted: true,
  }));
  assert.match(out, /reviewing it/);
  assert.doesNotMatch(out, /Do not give the answer/);
});

test('study view, thread and resource folder each reach the prompt', () => {
  const out = serializeScreenContext(ctx({
    studyView: 'mistakes',
    threadTitle: 'Titration endpoints',
    threadSubject: '0620',
    resourceFolderPath: 'Root / Chemistry / Past papers',
  }));
  assert.match(out, /Study view: mistakes/);
  assert.match(out, /Reading discussion thread: "Titration endpoints" \(0620\)/);
  assert.match(out, /Browsing resources in: Root \/ Chemistry \/ Past papers/);
});

test('an empty context is just the section, not a wall of undefineds', () => {
  const out = serializeScreenContext(ctx({}));
  assert.equal(out.split('\n').length, 1);
  assert.doesNotMatch(out, /undefined/);
});
