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
const VIEWS: StudyCoachView[] = ['today', 'plan', 'mistakes', 'review', 'mastery', 'search'];

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
  pageId: r.tab === 'materials' ? r.pageId ?? null : undefined,
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
    }
    if (tab === 'materials') {
      routes.push({ tab, pageId: 'cmt13awz4000004l965cg7idg' });
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

test('a notebook page is addressable on its own', () => {
  // The whole point of the parameter: a link with nothing but the page id has
  // to reach the page, because that is what someone pastes into a chat.
  const bare = parseRoute('?pageId=cmt13awz4000004l965cg7idg');
  assert.equal(bare?.tab, 'materials');
  assert.equal(bare?.pageId, 'cmt13awz4000004l965cg7idg');

  // And it survives alongside the tab it implies.
  const explicit = parseRoute('?tab=materials&pageId=cmt13awz4000004l965cg7idg');
  assert.equal(explicit?.pageId, 'cmt13awz4000004l965cg7idg');

  // Materials without a page is still Materials, not a broken link.
  assert.equal(parseRoute('?tab=materials')?.pageId, null);
});

test('a malformed page id is dropped rather than forwarded', () => {
  // This value reaches `GET /api/pages?pageId=` on mount. The route decides
  // who may read a page, but nothing that cannot be an id should get that far.
  for (const bad of ['', '../../etc/passwd', 'short', 'has-dashes-in-it', "' OR 1=1--", 'x'.repeat(64)]) {
    const parsed = parseRoute(`?tab=materials&pageId=${encodeURIComponent(bad)}`);
    assert.equal(parsed?.pageId, null, `accepted a malformed page id: ${bad}`);
  }

  // A bare malformed id names nothing at all, rather than silently landing on
  // Materials as though a real page had been asked for.
  assert.equal(parseRoute('?pageId=nope'), null);
});
