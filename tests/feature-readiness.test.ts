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
