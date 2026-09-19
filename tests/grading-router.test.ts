import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideGradingMode, hasGradableText } from '../lib/grading-router.ts';

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

/**
 * The gate is a gate, not a permanent refusal. On-demand transcription
 * (`lib/bank-transcription.ts`) fills `bodyMd` the first time a student
 * answers a crop-only question, and from that submission on the same question
 * arrives here with text -- so the routing it was refused before is exactly
 * the routing it must now get.
 */
test('a question that has since been transcribed routes to vision again', () => {
  assert.equal(
    decideGradingMode({
      requiresDiagram: true,
      answerImageUrl: '/uploads/images/answer.png',
      hasQuestionText: true,
    }),
    'vision',
  );
  assert.equal(
    decideGradingMode({ requiresDiagram: false, answerImageUrl: null, hasQuestionText: true }),
    'text',
  );
});

/**
 * Regression for a crop failure reaching the grader, found 18 Sep by sampling
 * gpt-5.6-sol's first transcripts: four 9608 questions came back as exactly
 * `![](asset:fig1)` and nothing else, because segmentation had handed the model
 * a 307x93 sliver of a table instead of a question. The model behaved well --
 * it did not invent a question -- but the body was truthy, so the
 * `hasQuestionText` gate opened and vision grading ran against a question with
 * no words in it. That is F16 again: a confident zero on an unreadable
 * question, which is worse than no mark at all.
 */
test('a body that is only a figure reference is not gradable', () => {
  assert.equal(hasGradableText('![](asset:fig1)'), false);
  assert.equal(
    hasGradableText('![](asset:fig1)\n\n![](asset:fig2)\n\n![](asset:fig3)'),
    false,
    'three references clear 40 characters on length alone, so length is not the test',
  );
});

test('markup alone is not prose', () => {
  assert.equal(
    hasGradableText('<table><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table>'),
    false,
  );
  assert.equal(hasGradableText('**(a)** [3]'), false, 'a part label with no question');
  assert.equal(hasGradableText('D8'), false, 'a cell lifted out of a table by a bad crop');
});

/**
 * The gate first reused the RAG index's `isRetrievableText`, which is a length
 * bar, and that silently excluded a whole subject: 0509 Chinese composition
 * prompts are complete questions in under forty characters. Grading is not
 * retrieval -- for a composition paper the title *is* the question, and it is
 * exactly the kind of paper answered with a photograph of handwriting, so
 * losing vision grading there is the opposite of what the gate is for.
 */
test('a short prompt in a dense script is a question', () => {
  assert.equal(hasGradableText('叙述你一次坐船的经历。'), true, 'Describe a boat journey');
  assert.equal(hasGradableText('晨露'), true, '"Morning dew" -- a complete essay title');
  assert.equal(hasGradableText('一个珍惜时间的人'), true);
});

test('a short prompt in Latin script is a question too', () => {
  // 0400 Art & Design prompts really are one word.
  assert.equal(hasGradableText('Shoppers'), true);
  assert.equal(hasGradableText('Worn out'), true);
});

test('a real question is gradable, figures and all', () => {
  const body =
    'A stack is created using a high-level language. Memory locations 200 to 207 ' +
    'are to be used to store the stack.\n\n![](asset:fig1)\n\nDescribe the algorithm.';
  assert.equal(hasGradableText(body), true);
});

test('empty and missing bodies are not gradable', () => {
  assert.equal(hasGradableText(''), false);
  assert.equal(hasGradableText(null), false);
  assert.equal(hasGradableText(undefined), false);
});

test('an unreadable question routes to text, never to a confident vision zero', () => {
  assert.equal(
    decideGradingMode({
      requiresDiagram: true,
      answerImageUrl: '/uploads/answer.png',
      hasQuestionText: hasGradableText('![](asset:fig1)'),
    }),
    'text',
    'vision here is exactly the F16 failure',
  );
});
