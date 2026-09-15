/**
 * The URL <-> tab-state mapping for the app shell.
 *
 * The shell at `app/page.tsx` keeps its five destinations as tab state rather
 * than as routes, and read the URL exactly once, on mount. So a student could
 * arrive at `/?tab=study` correctly, click three tabs, press Back — and leave
 * the site, because nothing had touched history since the page loaded. The
 * address bar also still said `?tab=study` while they were looking at
 * Discussions, which is what a shared link then carried.
 *
 * Pure and dependency-free so both directions can be round-trip tested.
 * `parseRoute` is deliberately lenient (it accepts the aliases that RAG
 * citations and AI actions emit); `routeToQuery` is deliberately canonical
 * (one spelling per destination), which is what makes them inverses.
 */

export type StudyCoachView = 'today' | 'plan' | 'mistakes' | 'review' | 'mastery' | 'search';
export type PracticeMode = 'browse' | 'practice';
export type MainTab = 'dashboard' | 'study' | 'practice' | 'materials' | 'mock-exams' | 'discussions';

export type RoutedTab = {
  tab: MainTab;
  studyView?: StudyCoachView;
  practiceMode?: PracticeMode;
  /** An id in the legacy text bank; opens QuestionsDatabase. */
  questionId?: number | null;
  /** An id in the crop-first bank; opens BankPractice. Never interchangeable
   * with `questionId` -- the two are separate tables. */
  bankQuestionId?: number | null;
  /** A notebook page, opened inside Materials' workspace view. Unlike the two
   * question ids this is a cuid, not an integer. */
  pageId?: string | null;
};

export const STUDY_VIEWS = new Set<StudyCoachView>([
  'today', 'plan', 'mistakes', 'review', 'mastery', 'search',
]);

/** The one spelling each destination is written back as. */
const CANONICAL: Record<MainTab, string> = {
  dashboard: 'dashboard',
  study: 'study',
  practice: 'practice',
  materials: 'materials',
  'mock-exams': 'mock-exams',
  discussions: 'discussions',
};

export const resolveRoute = (raw: string | null): RoutedTab | null => {
  switch (raw) {
    case 'dashboard':
    case 'daily':
      return { tab: 'dashboard' };
    case 'study':
    case 'study-coach':
      return { tab: 'study' };
    case 'practice':
    case 'questions-db':
      return { tab: 'practice' };
    case 'materials':
    case 'notes-textbook':
    case 'resources':
    // `lib/rag-index.ts` emits `?tab=notes` for the legacy `Note` model. It is
    // a different store from the notebook system behind Materials, but
    // Materials is where notes live as far as a student is concerned, and
    // landing there beats the silent fall-through to the dashboard that every
    // unmatched value gets. Currently inert -- production holds no indexed
    // documents on this route -- but the emitter is live, so the gap is one
    // reindex away from mattering.
    case 'notes':
      return { tab: 'materials' };
    case 'mock-exams':
      return { tab: 'mock-exams' };
    case 'discussions':
      return { tab: 'discussions' };
    case 'weaknesses':
      return { tab: 'study', studyView: 'mastery' };
    // Competition questions are indexed with this route, but the vault they
    // live in is behind the unlock widget, so there is nothing to deep-link a
    // locked student to. Practice is the right neighbourhood and does not
    // quietly hand out the unlock. Also inert today: no indexed document
    // carries this route either.
    case 'competition':
      return { tab: 'practice' };
    default:
      return null;
  }
};

const positiveInt = (raw: string | null): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Page ids are cuids. Shape-check rather than trust: this value reaches
 * `GET /api/pages?pageId=` on mount, and the route is the thing that decides
 * whether the viewer may read it -- but there is no reason to forward
 * something that cannot be an id in the first place.
 */
const pageId = (raw: string | null): string | null =>
  raw && /^[a-z0-9]{16,40}$/i.test(raw) ? raw : null;

/** A full location.search -> the destination it names, defaults filled in. */
export const parseRoute = (search: string): RoutedTab | null => {
  const params = new URLSearchParams(search);
  const base = resolveRoute(params.get('tab'));
  const requestedView = params.get('view') as StudyCoachView | null;
  const questionId = positiveInt(params.get('qid'));
  const bankQuestionId = positiveInt(params.get('bqid'));
  const notePageId = pageId(params.get('pageId'));

  const route = base
    ?? (questionId || bankQuestionId ? { tab: 'practice' as const } : null)
    // A bare `?pageId=` names Materials the same way a bare `?bqid=` names
    // Practice, so a link to a page survives without carrying the tab too.
    ?? (notePageId ? { tab: 'materials' as const } : null);
  if (!route) return null;

  const resolved: RoutedTab = { ...route };
  if (resolved.tab === 'study') {
    const view = requestedView && STUDY_VIEWS.has(requestedView) ? requestedView : resolved.studyView;
    resolved.studyView = view ?? 'today';
  }
  if (resolved.tab === 'materials') {
    resolved.pageId = notePageId ?? resolved.pageId ?? null;
  }
  if (resolved.tab === 'practice') {
    resolved.questionId = questionId ?? resolved.questionId ?? null;
    resolved.bankQuestionId = bankQuestionId ?? resolved.bankQuestionId ?? null;
    resolved.practiceMode = params.get('mode') === 'practice' || resolved.questionId || resolved.bankQuestionId
      ? 'practice'
      : resolved.practiceMode ?? 'browse';
  }
  return resolved;
};

/** The inverse: a destination -> the query string that names it. */
export const routeToQuery = (route: RoutedTab): string => {
  const params = new URLSearchParams();
  params.set('tab', CANONICAL[route.tab]);
  if (route.tab === 'study' && route.studyView && route.studyView !== 'today') {
    params.set('view', route.studyView);
  }
  if (route.tab === 'materials' && route.pageId) {
    params.set('pageId', route.pageId);
  }
  if (route.tab === 'practice') {
    if (route.questionId) params.set('qid', String(route.questionId));
    if (route.bankQuestionId) params.set('bqid', String(route.bankQuestionId));
    // `mode` is redundant once an id is present -- an id always means practice
    // -- so it is only written when it is the only thing saying so.
    if (route.practiceMode === 'practice' && !route.questionId && !route.bankQuestionId) {
      params.set('mode', 'practice');
    }
  }
  return params.toString();
};
