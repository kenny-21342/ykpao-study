import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLAN_DAYS,
  averageIntensity,
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

/**
 * The budget and the daily capacity must be priced on the same curve.
 *
 * `generatePlan` sets its minute budget from `days / 7` and then spends each
 * day at `base * intensityAt(...)`. With a ramp, spending outruns the budget
 * and the plan stops early -- observed in production on 5 Sep 2026 as a
 * 21-day window that scheduled nothing after day 14, leaving the final week
 * before the exam empty.
 */
test('a flat window has no ramp to pay for', () => {
  const window = planWindow({ examDate: null, now });
  assert.equal(averageIntensity(window), 1);
});

test('an exam far off does not ramp, so the budget is unchanged', () => {
  const window = planWindow({ examDate: inDays(200), now });
  assert.equal(window.peakIntensity, 1);
  assert.equal(averageIntensity(window), 1);
});

test('the average sits between the first day and the peak', () => {
  const window = planWindow({ examDate: inDays(21), now });
  const mean = averageIntensity(window);
  assert.ok(mean > 1, 'a ramping window must cost more than a flat one');
  assert.ok(mean < window.peakIntensity, 'the mean cannot reach the peak');
});

test('the average matches the ramp it is derived from', () => {
  const window = planWindow({ examDate: inDays(21), now });
  let total = 0;
  for (let offset = 0; offset < window.days; offset += 1) total += intensityAt(window, offset);
  assert.equal(averageIntensity(window), total / window.days);
});

test('a budget scaled by the average covers every day of the window', () => {
  // The regression itself, as arithmetic: spend each day at its ramped
  // capacity and confirm the budget lasts to the final day.
  for (const daysOut of [8, 14, 21, 28]) {
    const window = planWindow({ examDate: inDays(daysOut), now });
    const perWeek = 345;                       // the measured profile
    const daily = perWeek / 7;
    const budget = perWeek * (window.days / 7) * averageIntensity(window);
    let spent = 0;
    let lastFundedDay = -1;
    for (let offset = 0; offset < window.days; offset += 1) {
      const capacity = daily * intensityAt(window, offset);
      if (spent + capacity > budget + 1e-9) break;
      spent += capacity;
      lastFundedDay = offset;
    }
    assert.equal(
      lastFundedDay,
      window.days - 1,
      `a ${daysOut}-day window ran out of budget on day ${lastFundedDay + 1}`,
    );
  }
});

test('the old flat budget is what left the final week empty', () => {
  // Guards the diagnosis, not just the fix: without the factor, a 21-day
  // window must still fall short, or this test is asserting nothing.
  const window = planWindow({ examDate: inDays(21), now });
  const perWeek = 345;
  const daily = perWeek / 7;
  const flatBudget = perWeek * (window.days / 7);
  let spent = 0;
  let funded = 0;
  for (let offset = 0; offset < window.days; offset += 1) {
    const capacity = daily * intensityAt(window, offset);
    if (spent + capacity > flatBudget + 1e-9) break;
    spent += capacity;
    funded += 1;
  }
  assert.ok(funded < window.days, 'the flat budget should not have reached the exam');
});
