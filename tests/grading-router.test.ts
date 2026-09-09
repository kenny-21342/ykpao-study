import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideGradingMode } from '../lib/grading-router.ts';

/**
 * Which grader an attempt is routed to.
 *
 * The gate that matters here is `hasQuestionText`. The crop-first bank stores
 * questions as image strips and leaves `bodyMd` empty for the whole crop-only
 * corpus, so a student who drew on the scratchpad was sending their answer to
 * a vision marker that had been given an empty `Question:` heading. It said as
 * much in the feedback -- "impossible to determine what the student was
 * supposed to draw" -- and returned a score of zero, which the submit route
 * then persisted as a real mark.
 */

test('an image answer routes to vision when the question has been transcribed', () => {
  assert.equal(
    decideGradingMode({
      requiresDiagram: false,
      answerImageUrl: '/uploads/images/answer.png',
      hasQuestionText: true,
    }),
    'vision',
  );
});

test('a diagram-flagged question routes to vision even with no image attached', () => {
  assert.equal(
    decideGradingMode({ requiresDiagram: true, answerImageUrl: null, hasQuestionText: true }),
    'vision',
  );
});

test('a plain typed answer keeps the text path', () => {
  assert.equal(
    decideGradingMode({ requiresDiagram: false, answerImageUrl: null, hasQuestionText: true }),
    'text',
  );
});

test('an untranscribed question never routes to vision, whatever else is true', () => {
  for (const requiresDiagram of [false, true]) {
    for (const answerImageUrl of [null, '/uploads/images/answer.png']) {
      assert.equal(
        decideGradingMode({ requiresDiagram, answerImageUrl, hasQuestionText: false }),
        'text',
        `routed to vision with no question text (diagram=${requiresDiagram}, image=${answerImageUrl})`,
      );
    }
  }
});
