import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conflictWithSubject,
  formatQuestionCode,
  isEmptyQuery,
  parseQuestionQuery,
  storedSession,
  type PaperForCode,
} from '../lib/bank-search.ts';

// Shapes taken from real rows in the bank (extract.db), one per variety.
const ib = (over: Partial<PaperForCode>): PaperForCode => ({
  board: 'IB', subjectCode: 'physics', level: 'SL', year: 2021, session: 'May',
  paperNumber: 1, variant: 0, timezone: 'TZ1', ...over,
});
const caie = (over: Partial<PaperForCode>): PaperForCode => ({
  board: 'CAIE', subjectCode: '0625', level: 'igcse', year: 2021, session: 's',
  paperNumber: 4, variant: 2, timezone: null, ...over,
});

test('IB codes read the way teachers say them', () => {
  assert.equal(formatQuestionCode(ib({}), 22), '21M.1SL.TZ1.22');
  assert.equal(formatQuestionCode(ib({ session: 'November', timezone: null, level: 'HL', paperNumber: 2 }), 17), '21N.2HL.TZ0.17');
  assert.equal(formatQuestionCode(ib({ year: 2025, variant: 2, timezone: 'TZ2' }), 5), '25M.1BSL.TZ2.5');
});

test('CAIE codes carry paper+variant and the session letters', () => {
  assert.equal(formatQuestionCode(caie({}), 3), '0625/42/M/J/21 Q3');
  assert.equal(formatQuestionCode(caie({ session: 'w', paperNumber: 2, variant: 3, subjectCode: '0580', year: 2017 }), 8), '0580/23/O/N/17 Q8');
  assert.equal(formatQuestionCode(caie({ session: 'm', subjectCode: '9709', paperNumber: 1, variant: 2, year: 2020 }), 1), '9709/12/F/M/20 Q1');
});

test('the code a row shows is read back as the same paper and question', () => {
  const samples: PaperForCode[] = [
    ib({}), ib({ session: 'November', timezone: null, level: 'HL', paperNumber: 2 }),
    ib({ year: 2025, variant: 1, timezone: 'TZ3', level: 'HL' }), ib({ level: 'HLSL', paperNumber: 3 }),
    caie({}), caie({ session: 'w', year: 2015, paperNumber: 2, variant: 3, subjectCode: '0610' }),
    caie({ session: 'm', year: 2025, paperNumber: 2, variant: 2, subjectCode: '0500' }),
  ];
  for (const paper of samples) {
    const code = formatQuestionCode(paper, 12);
    const parsed = parseQuestionQuery(code);
    assert.equal(parsed.year, paper.year, code);
    assert.equal(parsed.question, 12, code);
    assert.equal(parsed.paperNumber, paper.paperNumber, code);
    assert.deepEqual(parsed.words, [], code);
    if (paper.board === 'IB') {
      assert.equal(parsed.month, paper.session, code);
      assert.equal(parsed.timezone, paper.timezone, code);
      assert.equal(parsed.level, paper.level, code);
      assert.equal(parsed.variant, paper.variant || undefined, code);
    } else {
      assert.equal(storedSession('CAIE', parsed.month!), paper.session, code);
      assert.equal(parsed.syllabus, paper.subjectCode, code);
      assert.equal(parsed.variant, paper.variant, code);
    }
  }
});

test('IB codes are accepted with the dots in other places', () => {
  assert.deepEqual(parseQuestionQuery('21M.1.SL.TZ1.22'), {
    year: 2021, month: 'May', paperNumber: 1, level: 'SL', timezone: 'TZ1', question: 22, words: [],
  });
  const noZone = parseQuestionQuery('21n.2hl.17');
  assert.equal(noZone.month, 'November');
  assert.equal(noZone.question, 17);
  assert.equal(noZone.timezone, undefined);
});

test('the CAIE file name works too', () => {
  const parsed = parseQuestionQuery('0625_s21_qp_42 q3');
  assert.deepEqual([parsed.syllabus, parsed.year, parsed.month, parsed.paperNumber, parsed.variant, parsed.question],
    ['0625', 2021, 'May', 4, 2, 3]);
});

test('loose entries narrow without needing a full code', () => {
  assert.deepEqual(parseQuestionQuery('22'), { question: 22, words: [] });
  assert.deepEqual(parseQuestionQuery('Q22'), { question: 22, words: [] });
  assert.deepEqual(parseQuestionQuery('q 7'), { question: 7, words: [] });
  assert.deepEqual(parseQuestionQuery('1SL 22'), { paperNumber: 1, level: 'SL', question: 22, words: [] });
  assert.deepEqual(parseQuestionQuery('2023 p1 q3'), { year: 2023, paperNumber: 1, question: 3, words: [] });
  assert.deepEqual(parseQuestionQuery('Q3(a)(ii)'), { question: 3, words: [] });
  assert.deepEqual(parseQuestionQuery('paper 2 may'), { paperNumber: 2, month: 'May', words: [] });
});

test('leftover words become the keyword search, without wildcards', () => {
  const parsed = parseQuestionQuery('projectile 100% motion_x');
  assert.deepEqual(parsed.words, ['projectile', '100', 'motionx']);
  assert.equal(parseQuestionQuery('%%__').words.length, 0);
  assert.equal(parseQuestionQuery('aa bb cc dd ee ff gg').words.length, 4);
});

test('the first mention of a field wins', () => {
  assert.equal(parseQuestionQuery('2023 2024').year, 2023);
});

test('an empty or wordless query is empty', () => {
  assert.equal(isEmptyQuery(parseQuestionQuery('')), true);
  assert.equal(isEmptyQuery(parseQuestionQuery('  ,; ')), true);
  assert.equal(isEmptyQuery(parseQuestionQuery('q1')), false);
});

test('a code that contradicts the chosen subject is named, not answered with nothing', () => {
  const physicsSl = { board: 'IB', code: 'physics', level: 'SL', name: 'Physics (IB SL)' };
  assert.match(conflictWithSubject(parseQuestionQuery('21M.1HL.TZ1.22'), physicsSl) ?? '', /HL.*SL/);
  assert.equal(conflictWithSubject(parseQuestionQuery('21M.1SL.TZ1.22'), physicsSl), null);
  assert.equal(conflictWithSubject(parseQuestionQuery('21M.1HL.TZ1.22'), { ...physicsSl, level: 'HLSL' }), null);
  const caiePhysics = { board: 'CAIE', code: '9702', level: 'a-level', name: 'Physics (A Level)' };
  assert.match(conflictWithSubject(parseQuestionQuery('0625/42/M/J/21'), caiePhysics) ?? '', /0625/);
  assert.equal(conflictWithSubject(parseQuestionQuery('9702/42/M/J/21'), caiePhysics), null);
  assert.match(conflictWithSubject(parseQuestionQuery('feb'), physicsSl) ?? '', /February/);
});
