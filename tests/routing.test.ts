import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseRoute,
  resolveRoute,
  routeToQuery,
  type MainTab,
  type RoutedTab,
  type StudyCoachView,
} from '../app/components/routing.ts';

const TABS: MainTab[] = ['dashboard', 'study', 'practice', 'materials', 'mock-exams', 'discussions'];
const VIEWS: StudyCoachView[] = ['today', 'plan', 'mistakes', 'review', 'mastery'];

/**
 * parseRoute fills defaults that a caller may have left off, so compare the
 * effective destination rather than the literal object: `{tab:'study'}` and
 * `{tab:'study', studyView:'today'}` are the same place.
 */
const effective = (r: RoutedTab) => ({
  tab: r.tab,
  studyView: r.tab === 'study' ? r.studyView ?? 'today' : undefined,
  questionId: r.tab === 'practice' ? r.questionId ?? null : undefined,
  bankQuestionId: r.tab === 'practice' ? r.bankQuestionId ?? null : undefined,
  subjectCode: r.tab === 'practice' || r.tab === 'mock-exams' ? r.subjectCode ?? null : undefined,
  practiceMode: r.tab === 'practice'
    ? (r.questionId || r.bankQuestionId ? 'practice' : r.practiceMode ?? 'browse')
    : undefined,
});

test('every destination survives a round trip through the URL', () => {
  const routes: RoutedTab[] = [];
  for (const tab of TABS) {
    routes.push({ tab });
    if (tab === 'study') for (const studyView of VIEWS) routes.push({ tab, studyView });
    if (tab === 'practice') {
      routes.push({ tab, practiceMode: 'browse' });
      routes.push({ tab, practiceMode: 'practice' });
      routes.push({ tab, questionId: 4211, practiceMode: 'practice' });
      routes.push({ tab, bankQuestionId: 47552, practiceMode: 'practice' });
      routes.push({ tab, subjectCode: '0625', practiceMode: 'browse' });
    }
    if (tab === 'mock-exams') {
      routes.push({ tab, subjectCode: '9702' });
    }
  }

  for (const route of routes) {
    const parsed = parseRoute(routeToQuery(route));
    assert.ok(parsed, `routeToQuery produced a query parseRoute rejects: ${routeToQuery(route)}`);
    assert.deepEqual(
      effective(parsed!),
      effective(route),
      `round trip lost information for ${JSON.stringify(route)} -> ?${routeToQuery(route)}`,
    );
  }
});

test('routeToQuery is canonical where resolveRoute is lenient', () => {
  // The aliases exist because RAG citations and AI actions emit them. They
  // must keep resolving, but only one spelling may ever be written back, or
  // the address bar disagrees with itself between visits.
  for (const [alias, canonical] of [
    ['daily', 'dashboard'],
    ['study-coach', 'study'],
    ['questions-db', 'practice'],
    ['notes-textbook', 'materials'],
    ['resources', 'materials'],
    ['notes', 'materials'],
    ['competition', 'practice'],
  ] as const) {
    const route = resolveRoute(alias);
    assert.ok(route, `${alias} no longer resolves`);
    assert.equal(new URLSearchParams(routeToQuery(route!)).get('tab'), canonical);
  }

  // `weaknesses` is the one alias that carries a study view, so it round-trips
  // to a different spelling than it came in as, and must keep the view.
  const weak = resolveRoute('weaknesses')!;
  assert.deepEqual(effective(parseRoute(routeToQuery(weak))!), effective(weak));
  assert.equal(parseRoute(routeToQuery(weak))!.studyView, 'mastery');
});

test('an unknown or absent tab is not a destination', () => {
  for (const raw of ['', 'nonsense', 'admin', 'Study']) {
    assert.equal(resolveRoute(raw), null, `${raw} should not resolve`);
  }
  assert.equal(parseRoute(''), null);
  assert.equal(parseRoute('?admin=forbidden'), null);
});

test('a bare question id opens the question it names', () => {
  // `?qid=` and `?bqid=` are what a shared link from a mistake card carries.
  // A bare bqid used to set pending state that only the practice tab reads,
  // while leaving the student on the dashboard — so the link did nothing.
  const legacy = parseRoute('?qid=4211');
  assert.deepEqual(effective(legacy!), effective({ tab: 'practice', questionId: 4211 }));

  const bank = parseRoute('?bqid=47552');
  assert.deepEqual(effective(bank!), effective({ tab: 'practice', bankQuestionId: 47552 }));
  assert.equal(bank!.practiceMode, 'practice');

  // The two id spaces are separate tables and must never cross over.
  assert.equal(legacy!.bankQuestionId, null);
  assert.equal(bank!.questionId, null);
});

test('a malformed id is ignored rather than routed to', () => {
  for (const bad of ['?qid=0', '?qid=-3', '?qid=abc', '?qid=1.5', '?bqid=0', '?bqid=x']) {
    assert.equal(parseRoute(bad), null, `${bad} should not be a destination`);
  }
});

test('a leftover pageId link lands on Materials rather than nowhere', () => {
  // The notebook was removed on 28 Sep 2026 and `pageId` went with it. Links
  // to a page are still out there, in chats and in RAG documents indexed
  // before the removal, so they have to land somewhere sensible.
  assert.equal(parseRoute('?tab=materials&pageId=cmt13awz4000004l965cg7idg')?.tab, 'materials');
  // The old alias for the notebook half of Materials still resolves too.
  assert.equal(resolveRoute('notes-textbook')?.tab, 'materials');
  // But a bare page id now names nothing: there is no page to open.
  assert.equal(parseRoute('?pageId=cmt13awz4000004l965cg7idg'), null);
});

test('a subject code only survives on the two tabs that can act on it', () => {
  // Practice resolves it against the bank's subject list and Mock exams
  // generates from it. Nothing else has a subject parameter, so writing one
  // there would be a link that silently ignores half of itself -- which is the
  // thing the course cards did before this existed.
  assert.equal(routeToQuery({ tab: 'practice', subjectCode: '0625' }), 'tab=practice&subject=0625');
  assert.equal(routeToQuery({ tab: 'mock-exams', subjectCode: '0625' }), 'tab=mock-exams&subject=0625');
  assert.equal(routeToQuery({ tab: 'study', subjectCode: '0625' }), 'tab=study');
  assert.equal(routeToQuery({ tab: 'materials', subjectCode: '0625' }), 'tab=materials');
});

test('a subject code that cannot be a syllabus code is dropped, not forwarded', () => {
  assert.equal(parseRoute('tab=practice&subject=0625')?.subjectCode, '0625');
  assert.equal(parseRoute('tab=practice&subject=9702')?.subjectCode, '9702');
  // Shape-checked for the same reason as pageId: no reason to pass on
  // something that cannot be an identifier.
  for (const bad of ['', '../etc', 'a b', "0625'--", 'x'.repeat(40)]) {
    assert.equal(
      parseRoute(`tab=practice&subject=${encodeURIComponent(bad)}`)?.subjectCode,
      null,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('a retired study view falls back to today rather than a blank page', () => {
  // `view=search` was a real destination until the Study search box was
  // removed as a duplicate of the Cmd+K palette. Links to it are still out
  // there, in old AI citations among other places.
  const parsed = parseRoute('?tab=study&view=search');
  assert.ok(parsed);
  assert.equal(parsed.studyView, 'today');
});
