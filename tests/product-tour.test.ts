import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOUR_STEPS, cardPosition, visibleSteps } from '../lib/product-tour.ts';

test('every step names an anchor and reads as a sentence', () => {
  assert.ok(TOUR_STEPS.length >= 5);
  for (const step of TOUR_STEPS) {
    assert.match(step.anchor, /^[a-z-]+$/, `${step.anchor} must be a data-tour value`);
    assert.ok(step.title.length > 0 && step.title.length <= 40);
    assert.ok(step.body.endsWith('.'), `${step.title} body should be a sentence`);
  }
});

test('anchors are unique, so no step highlights the same thing twice', () => {
  const anchors = TOUR_STEPS.map((s) => s.anchor);
  assert.equal(new Set(anchors).size, anchors.length);
});

test('steps whose anchor is missing are dropped', () => {
  // Practice and Mock exams sit behind feature flags.
  const present = new Set(['nav-dashboard', 'nav-study', 'search']);
  const steps = visibleSteps(TOUR_STEPS, (a) => present.has(a));
  assert.deepEqual(steps.map((s) => s.anchor), ['nav-dashboard', 'nav-study', 'search']);
});

test('no visible anchors yields an empty tour rather than a broken one', () => {
  assert.deepEqual(visibleSteps(TOUR_STEPS, () => false), []);
});

const VIEWPORT = { width: 1440, height: 900 };
const CARD = { width: 320, height: 190 };

test('a right-placed card sits beside its anchor', () => {
  const pos = cardPosition({ top: 100, left: 16, width: 240, height: 48 }, CARD, VIEWPORT, 'right');
  assert.equal(pos.left, 16 + 240 + 12);
  assert.equal(pos.top, 100);
});

test('it flips below when there is no room to the right', () => {
  // A phone-width viewport where the sidebar takes most of the screen.
  const narrow = { width: 390, height: 844 };
  const pos = cardPosition({ top: 100, left: 16, width: 300, height: 48 }, CARD, narrow, 'right');
  assert.equal(pos.top, 100 + 48 + 12);
  assert.ok(pos.left + CARD.width <= narrow.width, 'card must stay on screen');
});

test('it flips above when there is no room below either', () => {
  const pos = cardPosition({ top: 700, left: 16, width: 300, height: 48 }, CARD, { width: 390, height: 844 }, 'right');
  assert.equal(pos.top, 700 - 12 - CARD.height);
});

test('the card never leaves the viewport', () => {
  for (const rect of [
    { top: -50, left: -50, width: 40, height: 40 },
    { top: 880, left: 1400, width: 40, height: 40 },
    { top: 0, left: 0, width: 0, height: 0 },
  ]) {
    const pos = cardPosition(rect, CARD, VIEWPORT, 'right');
    assert.ok(pos.top >= 0 && pos.left >= 0, `top/left clamped for ${JSON.stringify(rect)}`);
    assert.ok(pos.top + CARD.height <= VIEWPORT.height);
    assert.ok(pos.left + CARD.width <= VIEWPORT.width);
  }
});

test('a left-placed card falls back to below when it would go off the left edge', () => {
  const pos = cardPosition({ top: 100, left: 10, width: 40, height: 40 }, CARD, VIEWPORT, 'left');
  assert.equal(pos.top, 100 + 40 + 12);
});
