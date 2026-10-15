/**
 * What the Practice tab remembers while the browser tab stays open.
 *
 * `HomeShell` renders the tab as `activeTab === 'practice' && <BankPractice/>`,
 * so leaving it unmounts the component and every `useState` inside it goes
 * with it: the subject, year, session, paper, topic, the page number and the
 * question being read. A student who opened a question, went to Study for a
 * minute and came back was on page 1 of every subject again.
 *
 * sessionStorage rather than localStorage on purpose: it survives switching
 * tabs and reloading, and it ends when the browser tab does. On a shared school
 * computer the next student does not inherit the last one's subject.
 *
 * Pure -- no `window` here -- so the validation can be tested. Everything read
 * back is untrusted: sessionStorage is editable from devtools, and a payload
 * written by an older build can have a different shape.
 */

export const MEMORY_VERSION = 1;

export type PracticeFilterMemory = {
  v: typeof MEMORY_VERSION;
  scope: 'enrolled' | 'all';
  /** bank subject id, as the select holds it. '' = all subjects. */
  subject: string;
  year: string;
  session: string;
  paperNumber: string;
  topic: string;
  onlyBookmarked: boolean;
  /** Free-text / question-number search box. */
  search: string;
  page: number;
  /** The question being read, or null when the list is showing. */
  selectedId: number | null;
  /** Scroll offset of the list, so "Back to questions" lands where you left. */
  scrollTop: number;
};

export const EMPTY_MEMORY: PracticeFilterMemory = {
  v: MEMORY_VERSION,
  scope: 'enrolled',
  subject: '',
  year: '',
  session: '',
  paperNumber: '',
  topic: '',
  onlyBookmarked: false,
  search: '',
  page: 1,
  selectedId: null,
  scrollTop: 0,
};

/** Keyed by user so a second account in the same browser tab never inherits it. */
export function memoryKey(userId: string): string {
  return `practice:filters:v${MEMORY_VERSION}:${userId}`;
}

/** Hard ceiling on what is read back; a real payload is a few hundred bytes. */
const MAX_RAW_LENGTH = 2000;

const digits = (value: unknown, max: number): string | null =>
  typeof value === 'string' && /^\d*$/.test(value) && value.length <= max ? value : null;

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null;

export function serializeMemory(memory: PracticeFilterMemory): string {
  return JSON.stringify(memory);
}

/**
 * Parse and validate. Returns null for anything that is not exactly the shape
 * this build writes, rather than repairing it: a half-trusted payload is worse
 * than starting from the defaults.
 */
export function parseMemory(raw: string | null | undefined): PracticeFilterMemory | null {
  if (!raw || raw.length > MAX_RAW_LENGTH) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.v !== MEMORY_VERSION) return null;
  if (record.scope !== 'enrolled' && record.scope !== 'all') return null;
  if (typeof record.onlyBookmarked !== 'boolean') return null;

  const subject = digits(record.subject, 9);
  const year = digits(record.year, 4);
  const paperNumber = digits(record.paperNumber, 3);
  const session = text(record.session, 16);
  const topic = text(record.topic, 200);
  const search = text(record.search, 200);
  if ([subject, year, paperNumber, session, topic, search].some((field) => field === null)) return null;

  const page = record.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 100_000) return null;

  const selectedId = record.selectedId;
  if (
    selectedId !== null &&
    (typeof selectedId !== 'number' || !Number.isInteger(selectedId) || selectedId < 1)
  ) {
    return null;
  }

  const scrollTop = record.scrollTop;
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0 || scrollTop > 10_000_000) {
    return null;
  }

  return {
    v: MEMORY_VERSION,
    scope: record.scope,
    subject: subject!,
    year: year!,
    session: session!,
    paperNumber: paperNumber!,
    topic: topic!,
    onlyBookmarked: record.onlyBookmarked,
    search: search!,
    page,
    selectedId,
    scrollTop: Math.round(scrollTop),
  };
}
