/**
 * Shared vocabulary for the past paper browser.
 *
 * The database stores compact codes (`s`, `w`, `qp`); every human-facing label
 * is derived here so the API and the UI can never disagree.
 */

export const SESSION_LABELS: Record<string, string> = {
  // Cambridge
  m: 'Feb/March',
  s: 'May/June',
  w: 'Oct/Nov',
  // IB
  may: 'May',
  nov: 'November',
};

/** Chronological order within a year, for sorting exam series. */
const SESSION_ORDER: Record<string, number> = { m: 0, may: 1, s: 1, nov: 2, w: 2 };

export const DOC_TYPE_LABELS: Record<string, string> = {
  qp: 'Question Paper',
  au: 'Audio',
  ms: 'Mark Scheme',
  in: 'Insert',
  rb: 'Resource Booklet',
  qb: 'Question Booklet',
  tb: 'Text Booklet',
  cs: 'Case Study',
};

/**
 * Tab order in the viewer: the paper first, then its audio, then the mark
 * scheme, then extras. Audio outranks the mark scheme because a listening
 * paper cannot be attempted without it.
 */
const DOC_TYPE_ORDER = ['qp', 'au', 'ms', 'in', 'rb', 'qb', 'tb', 'cs'];

export function sessionLabel(session: string): string {
  return SESSION_LABELS[session] ?? session;
}

export function sessionOrder(session: string): number {
  return SESSION_ORDER[session] ?? 99;
}

export function docTypeLabel(docType: string): string {
  return DOC_TYPE_LABELS[docType] ?? docType.toUpperCase();
}

/**
 * Label for one document in a sitting.
 *
 * Type alone is enough for a paper or a mark scheme, but a listening sitting
 * carries four documents all typed `au`; the track number in the filename is
 * the only thing that distinguishes them, so four tabs reading "Audio" would
 * be four identical controls doing different things.
 */
export function documentLabel(document: { docType: string; filename: string }): string {
  if (document.docType !== 'au') return docTypeLabel(document.docType);
  // Anchored on the word, not on any digit: `.mp3` ends in one, so a bare
  // \d+ turns "listening.mp3" into "Track 3".
  const track = document.filename.match(/track[ _-]?(\d+)/i);
  return track ? `Track ${track[1]}` : docTypeLabel(document.docType);
}

export function docTypeOrder(docType: string): number {
  const index = DOC_TYPE_ORDER.indexOf(docType);
  return index === -1 ? DOC_TYPE_ORDER.length : index;
}

/** A curriculum is a board plus a qualification, e.g. Cambridge + IGCSE. */
export const BOARD_LABELS: Record<string, string> = {
  CAIE: 'Cambridge',
  IB: 'IB',
};

export function curriculumId(board: string, qualification: string): string {
  return `${board}|${qualification}`;
}

export function parseCurriculumId(id: string): { board: string; qualification: string } | null {
  const [board, qualification] = id.split('|');
  if (!board || qualification === undefined) return null;
  return { board, qualification };
}

export function curriculumLabel(board: string, qualification: string): string {
  const boardLabel = BOARD_LABELS[board] ?? board;
  // "IB Diploma Programme" reads better than "IB · Diploma Programme".
  return qualification ? `${boardLabel} ${qualification}` : boardLabel;
}

export type PaperDocument = {
  id: number;
  docType: string;
  docTypeLabel: string;
  filename: string;
  pageCount: number | null;
  sizeBytes: number | null;
};

/** One exam sitting, with every document belonging to it. */
export type PaperInstance = {
  key: string;
  subjectCode: string;
  subjectName: string;
  year: number;
  session: string;
  sessionLabel: string;
  paperNumber: number;
  paperCode: string;
  variant: number;
  level: string;
  timezone: string;
  label: string;
  documents: PaperDocument[];
};

type PaperRow = {
  id: number;
  year: number;
  session: string;
  paperNumber: number;
  paperCode: string;
  variant: number;
  level: string;
  timezone: string;
  docType: string;
  filename: string;
  pageCount: number | null;
  sizeBytes: number | null;
  subject: { code: string; name: string };
};

/** Human label for a sitting: "Paper 4 Variant 2" / "Paper 1A TZ1 HL". */
export function instanceLabel(row: {
  paperNumber: number;
  paperCode: string;
  variant: number;
  level: string;
  timezone: string;
}): string {
  // paperCode carries CAIE's paper+variant digits ("42"), which would read as
  // "Paper 42"; IB uses it for genuinely lettered papers such as "1A".
  const number = /[A-Za-z]/.test(row.paperCode) ? row.paperCode : String(row.paperNumber);
  const parts = [`Paper ${number}`];
  if (row.variant) parts.push(`Variant ${row.variant}`);
  if (row.timezone) parts.push(row.timezone);
  if (row.level) parts.push(row.level);
  return parts.join(' · ');
}

/**
 * Collapse document rows into exam sittings.
 *
 * A question paper and its mark scheme are the same sitting, so they share every
 * identity field and differ only by docType. For IB, level and timezone are part
 * of that identity: HL and SL are different exams, not different documents.
 */
export function groupIntoInstances(rows: PaperRow[]): PaperInstance[] {
  const instances = new Map<string, PaperInstance>();

  for (const row of rows) {
    const key = [
      row.subject.code,
      row.year,
      row.session,
      row.paperNumber,
      row.variant,
      row.level,
      row.timezone,
    ].join('|');

    let instance = instances.get(key);
    if (!instance) {
      instance = {
        key,
        subjectCode: row.subject.code,
        subjectName: row.subject.name,
        year: row.year,
        session: row.session,
        sessionLabel: sessionLabel(row.session),
        paperNumber: row.paperNumber,
        paperCode: row.paperCode,
        variant: row.variant,
        level: row.level,
        timezone: row.timezone,
        label: instanceLabel(row),
        documents: [],
      };
      instances.set(key, instance);
    }

    instance.documents.push({
      id: row.id,
      docType: row.docType,
      docTypeLabel: docTypeLabel(row.docType),
      filename: row.filename,
      pageCount: row.pageCount,
      sizeBytes: row.sizeBytes,
    });
  }

  const ordered = [...instances.values()];
  for (const instance of ordered) {
    instance.documents.sort((a, b) => docTypeOrder(a.docType) - docTypeOrder(b.docType));
  }

  return ordered.sort(
    (a, b) =>
      a.paperNumber - b.paperNumber ||
      a.paperCode.localeCompare(b.paperCode) ||
      a.variant - b.variant ||
      a.timezone.localeCompare(b.timezone) ||
      a.level.localeCompare(b.level),
  );
}
