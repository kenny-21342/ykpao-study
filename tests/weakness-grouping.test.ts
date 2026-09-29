import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupTopicsBySubject, type TopicRow } from '../lib/weakness-grouping.ts';

const row = (subject: string, topic: string, correct: number, total: number): TopicRow => ({
  key: `${subject}::${topic}`,
  subject,
  topic,
  total,
  correct,
  accuracy: total > 0 ? Math.round((correct / total) * 100) : 0,
  mastery: 0,
});

test('topics are grouped under their subject', () => {
  const groups = groupTopicsBySubject([
    row('Biology', 'Osmosis', 1, 4),
    row('Physics', 'Forces', 3, 4),
    row('Biology', 'Enzymes', 2, 4),
  ]);
  assert.deepEqual(groups.map((g) => g.subject), ['Biology', 'Physics']);
  assert.deepEqual(groups[0].topics.map((t) => t.topic), ['Osmosis', 'Enzymes']);
});

test('the weakest subject comes first, and the weakest topic inside it', () => {
  const groups = groupTopicsBySubject([
    row('Chemistry', 'Moles', 9, 10),
    row('Biology', 'Osmosis', 1, 10),
    row('Biology', 'Enzymes', 5, 10),
  ]);
  assert.equal(groups[0].subject, 'Biology');
  assert.deepEqual(groups[0].topics.map((t) => t.topic), ['Osmosis', 'Enzymes']);
});

test('a subject heading is computed from its own topic rows', () => {
  // 3 of 20 correct across the two topics.
  const [group] = groupTopicsBySubject([row('Biology', 'Osmosis', 1, 10), row('Biology', 'Enzymes', 2, 10)]);
  assert.equal(group.total, 20);
  assert.equal(group.correct, 3);
  assert.equal(group.accuracy, 15);
});

test('ties get a total order, so the grid does not reshuffle', () => {
  const input = [
    row('Biology', 'Beta', 0, 2),
    row('Biology', 'Alpha', 0, 9),
    row('Biology', 'Gamma', 0, 2),
  ];
  const once = groupTopicsBySubject(input)[0].topics.map((t) => t.topic);
  const twice = groupTopicsBySubject([...input].reverse())[0].topics.map((t) => t.topic);
  // Same accuracy for all three: more attempts first, then alphabetical.
  assert.deepEqual(once, ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(once, twice, 'order must not depend on input order');
});

test('a missing subject name is labelled rather than dropped', () => {
  const groups = groupTopicsBySubject([row('', 'Loose topic', 1, 2)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].subject, 'Unspecified');
});

test('no topics yields no groups', () => {
  assert.deepEqual(groupTopicsBySubject([]), []);
});

test('every topic survives grouping', () => {
  const input = Array.from({ length: 140 }, (_, i) => row(`Subject ${i % 7}`, `Topic ${i}`, i % 5, 5));
  const groups = groupTopicsBySubject(input);
  assert.equal(groups.reduce((sum, g) => sum + g.topics.length, 0), 140);
  assert.equal(groups.length, 7);
});
