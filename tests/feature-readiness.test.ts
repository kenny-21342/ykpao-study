import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_READINESS,
  featureReadiness,
  isFeaturePreview,
  isFeatureVisible,
  type PreviewFeature,
} from '../lib/feature-readiness.ts';

const features = Object.keys(FEATURE_READINESS) as PreviewFeature[];

test('both features are declared ready, and neither state drifts unnoticed', () => {
  /**
   * This used to pin both to 'preview', so that shipping a half-extracted
   * question bank with no warning on it took a deliberate act. The owner
   * took that act on 27 Sep 2026, with the measured numbers in front of him:
   * 98.2% of published questions transcribed, 74.9% with a mark scheme,
   * against 4.7% held back for a bad crop and topics on 39.2%.
   *
   * So the guard is inverted, not deleted. Its job was never to enforce one
   * particular state — it was to make sure the state cannot change by
   * accident, in either direction. Any edit to the table still has to come
   * here and say so.
   */
  assert.equal(FEATURE_READINESS['question-bank'].state, 'ready');
  assert.equal(FEATURE_READINESS['mock-exams'].state, 'ready');
});

test('a ready feature renders no banner and no badge anywhere', () => {
  // The entrances all gate on `state !== 'preview'`, so this is what actually
  // removes the treatment. Asserted through the helpers the UI calls rather
  // than by reading the table again, since those are what the components use.
  for (const feature of features) {
    assert.equal(isFeaturePreview(feature), false, `${feature} still renders a banner`);
    assert.equal(isFeatureVisible(feature), true, `${feature} lost its sidebar entrance`);
  }
});

test('every preview carries copy the banner can render', () => {
  for (const feature of features) {
    const readiness = featureReadiness(feature);
    if (readiness.state !== 'preview') continue;
    assert.ok(readiness.badge.length > 0, `${feature} has no badge`);
    assert.ok(readiness.title.length > 0, `${feature} has no title`);
    // Long enough to actually say what is missing, not just "coming soon".
    assert.ok(readiness.body.length > 40, `${feature} body is too thin`);
  }
});

test('a preview is visible and a hidden feature is not', () => {
  for (const feature of features) {
    assert.equal(isFeatureVisible(feature), FEATURE_READINESS[feature].state !== 'hidden');
    assert.equal(isFeaturePreview(feature), FEATURE_READINESS[feature].state === 'preview');
  }
});

test('the syllabus count is stated once and counted the same way everywhere', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  // The question-bank banner now appears on the signed-out landing page,
  // beside a live count of the same thing. They must agree.
  //
  // They did not: a `bank_subjects` row is (board, code, level), so counting
  // rows gave 82 while the banner said 41 -- two different numbers for the
  // platform's own size, on one page, to a stranger deciding whether to trust
  // it. Both now count distinct syllabus codes.
  const stated = /(\d+)\s+syllabuses/.exec(FEATURE_READINESS['question-bank'].body);
  assert.ok(stated, 'the question-bank copy must state a syllabus count');

  for (const file of ['app/components/LandingPage.tsx', 'app/api/platform-stats/route.ts']) {
    const src = await readFile(join(root, file), 'utf8');
    assert.match(
      src,
      /distinct: \['code'\]/,
      `${file} must count distinct syllabus codes, not bank_subjects rows`,
    );
  }
});

test('the bank copy tracks what the corpus actually has', () => {
  const body = FEATURE_READINESS['question-bank'].body;
  // This test used to require the phrase "marked by you", because `bodyMd`
  // was empty corpus-wide and the copy had to say so rather than imply the
  // questions were searchable prose. Its own comment said "until the
  // transcription waves land". They landed on 25 Sep: 65,572 of 66,756
  // published questions carry a transcript, `decideGradingMode`'s
  // `hasQuestionText` gate opens for them, and the AI marks written answers.
  //
  // So the guard is inverted rather than deleted. Understating a feature
  // misleads a student as surely as overstating it -- being told to mark your
  // own work by a platform that would have marked it costs real effort.
  assert.match(body, /crop/i);
  assert.doesNotMatch(body, /marked by you/i);
  assert.match(body, /transcript/i);
  // The crop failures are still real and must stay disclosed.
  assert.match(body, /held back/i);
});
