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

test('a prompt naming no course is answered unscoped, not blocked', () => {
  /**
   * Changed 27 Sep 2026 after seeing it in production: "Good morning" to a
   * student with twelve enrolments produced a wall of twelve buttons and no
   * answer. Naming no course is absence of a signal, not ambiguity between
   * candidates, and the tutor should still say something.
   *
   * The courses come back regardless, so the client can offer them as chips
   * under a real answer.
   */
  const result = resolveActiveCourse({ courses: [physics, biology], prompt: 'Explain my weakest topic' });
  assert.equal(result.activeCourse, null);
  assert.equal(result.clarificationRequired, false);
  assert.equal(result.status, 'unrestricted');
  assert.deepEqual(result.eligibleCourses.map((course) => course.id), ['physics', 'biology']);
});

test('a prompt matching two courses by name still asks', () => {
  // The case clarification is actually for: the student said something that
  // genuinely matches two of their courses, so one short question settles it
  // and the list is short enough to read.
  const igcsePhysics = { ...physics, id: 'physics-igcse', level: 'IGCSE' };
  const ibPhysics = { ...physics, id: 'physics-ib', level: 'IB' };
  const result = resolveActiveCourse({ courses: [igcsePhysics, ibPhysics], prompt: 'Explain Physics momentum' });
  assert.equal(result.clarificationRequired, true);
  assert.deepEqual(result.eligibleCourses.map((course) => course.id), ['physics-igcse', 'physics-ib']);
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
