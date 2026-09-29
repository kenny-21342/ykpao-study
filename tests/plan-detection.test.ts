import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePlan, parsePlanTasks } from '../lib/plan-detection.ts';

const DAY_PLAN = `Here is a focused plan for the next few days.

**Day 1**
- Revise trace tables: work through two examples by hand (30 min)
- Practise the \`mod\` operator on 10 short expressions (20 min)

**Day 2**
- Dry-run a nested selection program line by line (40 min)
- Review your notes on pseudocode conventions (15 min)

**Day 3**
- Attempt a past paper question on iteration (45 min)`;

const NUMBERED_PLAN = `A one-week revision schedule:

1. Revise cell structure and draw the organelles from memory
2. Practise 15 past paper questions on transport in cells
3. Review your mistakes from the last quiz
4. Attempt a timed mock paper on the whole topic`;

const EXPLANATION = `The \`mod\` operator returns the remainder of a division.

- \`7 mod 2\` is 1, because 7 divided by 2 leaves 1
- \`9 mod 3\` is 0, because 3 divides 9 exactly
- \`4 mod 5\` is 4, because 4 is smaller than 5

It is useful whenever you need to know if a number is even.`;

test('detects a plan laid out under day headings', () => {
  assert.equal(looksLikePlan(DAY_PLAN), true);
});

test('detects a numbered plan with no headings', () => {
  assert.equal(looksLikePlan(NUMBERED_PLAN), true);
});

test('does not treat a bulleted explanation as a plan', () => {
  assert.equal(looksLikePlan(EXPLANATION), false);
});

test('does not treat a short answer as a plan', () => {
  assert.equal(looksLikePlan('- revise this\n- revise that\n- revise the other'), false);
});

test('day headings set the offset, and items under one share it', () => {
  const tasks = parsePlanTasks(DAY_PLAN);
  assert.equal(tasks.length, 5);
  assert.deepEqual(tasks.map((task) => task.dayOffset), [0, 0, 1, 1, 2]);
});

test('a week heading is seven days, not one', () => {
  const tasks = parsePlanTasks(`## Week 2\n- Revise the whole unit (30 min)\n- Practise 10 questions\n- Review your mistakes`);
  assert.deepEqual(tasks.map((task) => task.dayOffset), [7, 7, 7]);
});

test('an unheaded list spreads one item per day', () => {
  assert.deepEqual(parsePlanTasks(NUMBERED_PLAN).map((task) => task.dayOffset), [0, 1, 2, 3]);
});

test('reads a stated duration and falls back to thirty minutes', () => {
  const tasks = parsePlanTasks(DAY_PLAN);
  assert.equal(tasks[0].durationMinutes, 30);
  assert.equal(tasks[1].durationMinutes, 20);
  assert.equal(tasks[2].durationMinutes, 40);
  assert.equal(parsePlanTasks(NUMBERED_PLAN)[0].durationMinutes, 30);
});

test('hours are converted to minutes and clamped', () => {
  const tasks = parsePlanTasks(`A short revision plan for the weekend:\n\n1. Revise the whole transport-in-cells topic for 2 hours\n2. Practise the past paper questions you skipped last time\n3. Review the mistakes you made in the last quiz`);
  assert.equal(tasks[0].durationMinutes, 120);
});

test('classifies the task type from the wording', () => {
  const tasks = parsePlanTasks(NUMBERED_PLAN);
  assert.deepEqual(tasks.map((task) => task.taskType), ['review', 'practice', 'review', 'mock-exam']);
});

test('strips markdown out of titles', () => {
  const tasks = parsePlanTasks(DAY_PLAN);
  assert.equal(tasks[1].title, 'Practise the mod operator on 10 short expressions (20 min)');
  assert.equal(tasks[1].topic, 'Practise the mod operator on 10 short expressions');
});

test('a weekday used as a list item stays a task rather than a date marker', () => {
  const tasks = parsePlanTasks(`Plan:\n- Monday: revise trace tables for 30 min\n- Tuesday: practise mod questions\n- Wednesday: review your mistakes`);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((task) => task.dayOffset), [0, 1, 2]);
});

test('parsePlanTasks returns nothing for prose that is not a plan', () => {
  assert.deepEqual(parsePlanTasks(EXPLANATION), []);
});

test('caps the number of tasks', () => {
  const long = `Plan:\n${Array.from({ length: 30 }, (_, i) => `${i + 1}. Revise topic ${i + 1} for 20 min`).join('\n')}`;
  assert.equal(parsePlanTasks(long).length, 12);
  assert.equal(parsePlanTasks(long, { maxTasks: 5 }).length, 5);
});

/**
 * The shape that actually broke this detector on first write: a model numbers
 * a plan's steps as markdown headings rather than as a list, and frames the
 * whole thing as today's work. Both the heading-numbered items and the
 * single-day scheduling are pinned here because inventing fixtures missed them.
 */
const HEADING_NUMBERED_PLAN = `Based on the screen you're working on, I'd focus today on IB Computer Science Paper 1 Algorithms, especially trace tables.

Today's Study Plan

#### 1. Master Trace Tables (20-30 min)
Practice variable updates, loops and conditional statements.

#### 2. Review the Meaning of mod (10 min)
Make sure you can instantly calculate 5 mod 3 = 2.

#### 3. Practise Dry Running Algorithms (20 min)
Read one line, update variables, record values immediately.

#### 4. Check Understanding of Nested Selection (15 min)
Make sure you can identify which branch runs.`;

test('detects a plan whose steps are numbered markdown headings', () => {
  assert.equal(looksLikePlan(HEADING_NUMBERED_PLAN), true);
  assert.deepEqual(parsePlanTasks(HEADING_NUMBERED_PLAN).map((task) => task.title), [
    'Master Trace Tables (20-30 min)',
    'Review the Meaning of mod (10 min)',
    'Practise Dry Running Algorithms (20 min)',
    'Check Understanding of Nested Selection (15 min)',
  ]);
});

test("a today-framed plan with no day markers schedules everything today", () => {
  assert.deepEqual(parsePlanTasks(HEADING_NUMBERED_PLAN).map((task) => task.dayOffset), [0, 0, 0, 0]);
});

test('a duration range takes the upper bound', () => {
  assert.equal(parsePlanTasks(HEADING_NUMBERED_PLAN)[0].durationMinutes, 30);
});

test('"master" and "check" count as study work and read as review', () => {
  const tasks = parsePlanTasks(HEADING_NUMBERED_PLAN);
  assert.equal(tasks[0].taskType, 'review');
  assert.equal(tasks[3].taskType, 'review');
});

test('a numbered heading that opens with a year is not a plan step', () => {
  assert.deepEqual(parsePlanTasks(`Revision plan for the week ahead:\n\n### 2024 past papers are the best source here\n- Revise the transport topic for 30 min\n- Practise ten questions on osmosis\n- Review your mistakes afterwards`).map((t) => t.title), [
    'Revise the transport topic for 30 min',
    'Practise ten questions on osmosis',
    'Review your mistakes afterwards',
  ]);
});
