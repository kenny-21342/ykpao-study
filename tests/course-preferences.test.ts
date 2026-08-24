import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { CoursePreferenceFields, describeValidationError, optionalIsoDate } from '../lib/course-preferences.ts';

/**
 * The production failure this guards: every one of these fields is backed by
 * an HTML input, and an untouched input submits '' rather than null. Saving a
 * course list with no exam dates therefore failed validation for every course
 * at once, and the raw zod issue array was rendered to the student.
 */

const Course = z.object({ courseId: z.string().min(1), ...CoursePreferenceFields });

test('an untouched date input saves instead of failing', () => {
  const parsed = Course.parse({ courseId: 'c1', examDate: '' });
  assert.equal(parsed.examDate, null);
});

test('every optional text field treats empty as unset', () => {
  const parsed = Course.parse({
    courseId: 'c1',
    targetGrade: '',
    examDate: '   ',
    currentLevel: '',
    recentResult: '',
  });
  assert.deepEqual(
    { g: parsed.targetGrade, d: parsed.examDate, l: parsed.currentLevel, r: parsed.recentResult },
    { g: null, d: null, l: null, r: null },
  );
});

test('a real date still round-trips, and a wrong one is still refused', () => {
  assert.equal(Course.parse({ courseId: 'c1', examDate: '2027-05-14' }).examDate, '2027-05-14');
  assert.throws(() => optionalIsoDate.parse('14/05/2027'));
  assert.throws(() => optionalIsoDate.parse('2027-02-30'));
});

test('null and absent both remain valid', () => {
  assert.equal(Course.parse({ courseId: 'c1', examDate: null }).examDate, null);
  assert.equal(Course.parse({ courseId: 'c1' }).examDate, undefined);
});

test('a rejection is described in words, not as a serialised issue array', () => {
  try {
    Course.parse({ courseId: 'c1', examDate: 'not-a-date' });
    assert.fail('should have thrown');
  } catch (error) {
    const message = describeValidationError(error);
    assert.ok(!message.includes('\\d'), 'must not leak the regex');
    assert.ok(!message.startsWith('['), 'must not be the raw issue array');
    assert.ok(message.includes('examDate'), `should name the field, got: ${message}`);
  }
});
