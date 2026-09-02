import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLAN_DAYS,
  describeCountdown,
  intensityAt,
  planWindow,
  reviewReservation,
  topicsToCover,
} from '../lib/revision-timetable.ts';

const now = new Date('2026-09-02T09:00:00');
/** A local-midnight date `days` from `now`, matching how the window counts. */
const inDays = (days: number) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);

test('no exam date keeps the rolling week exactly as it was', () => {
  const window = planWindow({ examDate: null, now });
  assert.equal(window.days, 7);
  assert.equal(window.phase, 'no-exam');
  assert.equal(window.peakIntensity, 1);
  assert.equal(window.daysUntilExam, null);
});

test('an exam in the past is treated as no exam, not as an emergency', () => {
  const window = planWindow({ examDate: inDays(-3), now });
  assert.equal(window.phase, 'no-exam');
  assert.equal(window.days, 7);
});

test('an exam today does not produce a zero-day plan', () => {
  const window = planWindow({ examDate: inDays(0), now });
  assert.equal(window.phase, 'no-exam');
  assert.equal(window.days, 7);
});

test('the plan never runs past the exam', () => {
  const window = planWindow({ examDate: inDays(3), now });
  assert.equal(window.days, 3);
  assert.equal(window.phase, 'final-week');
});

test('an exam three weeks out spans to the date', () => {
  const window = planWindow({ examDate: inDays(21), now });
  assert.equal(window.days, 21);
  assert.equal(window.daysUntilExam, 21);
  assert.equal(window.phase, 'approaching');
});

test('a distant exam plans a fortnight and does not ramp yet', () => {
  const window = planWindow({ examDate: inDays(300), now });
  assert.equal(window.days, 14);
  assert.equal(window.daysUntilExam, 300);
  assert.equal(window.phase, 'far');
  assert.equal(window.peakIntensity, 1, 'ramping ten months early burns a student out');
});

test('the window is capped even just past the limit', () => {
  const window = planWindow({ examDate: inDays(MAX_PLAN_DAYS + 1), now });
  assert.equal(window.days, 14);
});

test('intensity ramps from the first day to the last', () => {
  const window = planWindow({ examDate: inDays(21), now });
  assert.equal(intensityAt(window, 0), 1);
  assert.equal(intensityAt(window, window.days - 1), window.peakIntensity);
  assert.ok(intensityAt(window, 10) > intensityAt(window, 5));
});

test('a flat window never ramps', () => {
  const flat = planWindow({ examDate: null, now });
  for (const offset of [0, 3, 6]) assert.equal(intensityAt(flat, offset), 1);
});

test('intensity is clamped outside the window rather than extrapolated', () => {
  const window = planWindow({ examDate: inDays(21), now });
  assert.equal(intensityAt(window, -5), 1);
  assert.equal(intensityAt(window, 999), window.peakIntensity);
});

test('review time is reserved before practice is scheduled', () => {
  assert.equal(reviewReservation(0, 60), 0);
  assert.equal(reviewReservation(5, 60), 10);
});

test('a review backlog cannot consume the whole day', () => {
  assert.equal(reviewReservation(200, 60), 30);
  // Never more than half of a small day, so some practice always survives.
  assert.equal(reviewReservation(200, 30), 15);
  assert.equal(reviewReservation(10, 0), 0);
});

test('every weak topic is covered when there are slots for them', () => {
  const priorities = ['a', 'b', 'c'];
  assert.deepEqual(topicsToCover(priorities, 5), ['a', 'b', 'c']);
});

test('with fewer slots than topics the weakest come first', () => {
  // Priorities arrive sorted weakest-first.
  assert.deepEqual(topicsToCover(['weakest', 'middle', 'strongest'], 2), ['weakest', 'middle']);
});

test('no topics or no slots yields nothing rather than throwing', () => {
  assert.deepEqual(topicsToCover([], 5), []);
  assert.deepEqual(topicsToCover(['a'], 0), []);
});

test('the countdown reads naturally at each distance', () => {
  assert.equal(describeCountdown(planWindow({ examDate: null, now })), null);
  assert.equal(describeCountdown(planWindow({ examDate: inDays(1), now })), 'Your exam is tomorrow.');
  assert.equal(describeCountdown(planWindow({ examDate: inDays(5), now })), '5 days until your exam.');
  assert.match(describeCountdown(planWindow({ examDate: inDays(21), now }))!, /about 3 weeks/);
  assert.match(describeCountdown(planWindow({ examDate: inDays(8), now }))!, /about 1 week\./);
});
