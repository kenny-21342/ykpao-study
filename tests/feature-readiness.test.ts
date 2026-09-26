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

test('the unfinished features are declared as previews, not as ready', () => {
  // If either of these ever reads 'ready' by accident, the launch ships a
  // half-extracted question bank with no warning on it — the exact thing this
  // table exists to prevent.
  assert.equal(FEATURE_READINESS['question-bank'].state, 'preview');
  assert.equal(FEATURE_READINESS['mock-exams'].state, 'preview');
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
