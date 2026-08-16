import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The resolver is pure, but it shares a module with the Prisma-backed context
// loader. Stub that import so these precedence tests never need a database.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/prisma') {
      return { url: 'data:text/javascript,export const prisma = {}', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { LearnerContextError, resolveActiveCourse } = await import('../lib/learner-context.ts');

const physics = {
  id: 'physics', name: 'Physics', code: 'PHYS-IG', subject: 'Physics', level: 'IGCSE',
  scopes: [{ board: 'Cambridge', qualification: 'Cambridge IGCSE', level: 'IGCSE', subjectCode: '0625' }],
};
const biology = {
  id: 'biology', name: 'Biology', code: 'BIO-IG', subject: 'Biology', level: 'IGCSE',
  scopes: [{ board: 'Cambridge', qualification: 'Cambridge IGCSE', level: 'IGCSE', subjectCode: '0610' }],
};

test('explicit chat course wins over page, conversation, and prompt signals', () => {
  const result = resolveActiveCourse({
    courses: [physics, biology],
    explicitCourseId: biology.id,
    pageCourseId: physics.id,
    conversationCourseId: physics.id,
    prompt: 'Explain physics waves',
  });
  assert.equal(result.activeCourse?.id, biology.id);
  assert.equal(result.signal?.provenance, 'explicit-chat-course');
});

test('current-page syllabus code wins over established conversation', () => {
  const result = resolveActiveCourse({ courses: [physics, biology], pageSubjectCode: '0610', conversationCourseId: physics.id });
  assert.equal(result.activeCourse?.id, biology.id);
  assert.equal(result.signal?.provenance, 'current-page-course');
});

test('established conversation wins over a prompt-only course match', () => {
  const result = resolveActiveCourse({ courses: [physics, biology], conversationCourseId: physics.id, prompt: 'Explain biology cells' });
  assert.equal(result.activeCourse?.id, physics.id);
  assert.equal(result.signal?.provenance, 'conversation-course');
});

test('a unique prompt course resolves automatically', () => {
  const result = resolveActiveCourse({ courses: [physics, biology], prompt: 'Quiz me on Biology' });
  assert.equal(result.activeCourse?.id, biology.id);
  assert.equal(result.signal?.provenance, 'prompt-course-match');
});

test('ambiguous multi-course prompt requires clarification', () => {
  const result = resolveActiveCourse({ courses: [physics, biology], prompt: 'Explain my weakest topic' });
  assert.equal(result.activeCourse, null);
  assert.equal(result.clarificationRequired, true);
  assert.deepEqual(result.eligibleCourses.map((course) => course.id), ['physics', 'biology']);
});

test('sole enrollment resolves and no enrollment remains unrestricted', () => {
  assert.equal(resolveActiveCourse({ courses: [physics] }).signal?.provenance, 'sole-enrollment');
  assert.equal(resolveActiveCourse({ courses: [] }).status, 'unrestricted');
});

test('an unowned explicit course is rejected', () => {
  assert.throws(
    () => resolveActiveCourse({ courses: [physics], explicitCourseId: biology.id }),
    (error) => error instanceof LearnerContextError && error.status === 403,
  );
});

test('a conversation course removed from enrollment is ignored', () => {
  const result = resolveActiveCourse({ courses: [physics], conversationCourseId: biology.id });
  assert.equal(result.activeCourse?.id, physics.id);
  assert.equal(result.signal?.provenance, 'sole-enrollment');
});
