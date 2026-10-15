/**
 * Question codes: reading one off a list row, and typing one into the search box.
 *
 * Both directions live here so they cannot drift apart. A student who copies the
 * code a row shows must get exactly that question back, and `formatQuestionCode`
 * and `parseQuestionQuery` are tested as a round trip over real papers.
 *
 * The formats are the ones teachers already say out loud:
 *
 *   IB    21M.1SL.TZ1.22      year, May/November, paper+level, time zone, question
 *         25M.1ASL.TZ2.5      paper 1A/1B (2025 onwards) is the `variant`
 *         21N.2HL.TZ0.17      November papers with no time zone use TZ0, as the IB does
 *   CAIE  0625/42/M/J/21 Q3   syllabus / paper+variant / session / year, then the question
 *         0625_s21_qp_42      the file name, which is what a student has in front of them
 *
 * Loose entries -- `22`, `Q22`, `1SL 22`, `2023 p1 q3` -- narrow the list that is
 * already on screen, and whatever is left over is searched as words.
 *
 * Pure on purpose: no database, no `window`, no path aliases, so the node test
 * runner can import it directly.
 */

export type Month = 'May' | 'November' | 'February';

export type ParsedQuery = {
  /** Four digits, 20xx. */
  year?: number;
  month?: Month;
  paperNumber?: number;
  /** CAIE: the second digit of "42". IB: 1 for paper 1A, 2 for 1B. */
  variant?: number;
  level?: 'HL' | 'SL' | 'HLSL';
  /** 'TZ1'..'TZ3', or null for a TZ0 paper (no time zone). Undefined = unspecified. */
  timezone?: string | null;
  /** CAIE syllabus code, e.g. "0625". */
  syllabus?: string;
  question?: number;
  /** Anything that was not a code, for the keyword search. */
  words: string[];
};

export type PaperForCode = {
  board: string;
  subjectCode: string;
  level: string | null;
  year: number;
  session: string;
  paperNumber: number;
  variant: number;
  timezone: string | null;
};

const CAIE_SESSION: Record<string, { letters: [string, string]; month: Month }> = {
  s: { letters: ['M', 'J'], month: 'May' },
  w: { letters: ['O', 'N'], month: 'November' },
  m: { letters: ['F', 'M'], month: 'February' },
};

const pad2 = (value: number) => String(value % 100).padStart(2, '0');

export function formatQuestionCode(paper: PaperForCode, rootNumber: number): string {
  if (paper.board === 'IB') {
    const sitting = paper.session === 'November' ? 'N' : 'M';
    const variant = paper.variant > 0 ? String.fromCharCode(64 + paper.variant) : '';
    const level = paper.level ?? '';
    const zone = paper.timezone ?? 'TZ0';
    return `${pad2(paper.year)}${sitting}.${paper.paperNumber}${variant}${level}.${zone}.${rootNumber}`;
  }
  const session = CAIE_SESSION[paper.session];
  const sitting = session ? `${session.letters[0]}/${session.letters[1]}` : paper.session;
  const component = `${paper.paperNumber}${paper.variant > 0 ? paper.variant : ''}`;
  return `${paper.subjectCode}/${component}/${sitting}/${pad2(paper.year)} Q${rootNumber}`;
}

/** Month as a student types it -> the month this module uses. */
const MONTH_WORDS: Array<[RegExp, Month]> = [
  [/^(may|jun|june)$/i, 'May'],
  [/^(nov|november|oct|october)$/i, 'November'],
  [/^(feb|february|march)$/i, 'February'],
];

/**
 * Map a month onto what the paper row stores. The two boards disagree: IB keeps
 * 'May' / 'November', CAIE keeps 's' / 'w' / 'm'. Which one applies is the
 * chosen subject's board, which is why this is separate from parsing.
 */
export function storedSession(board: string, month: Month): string | null {
  if (board === 'IB') return month === 'February' ? null : month;
  return month === 'May' ? 's' : month === 'November' ? 'w' : 'm';
}

/** Split off anything that is not a letter, digit or a character a code uses. */
function tokenize(query: string): string[] {
  return query
    .replace(/[,;]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** The words that survive into the keyword search: no wildcards, no punctuation soup. */
function cleanWord(token: string): string | null {
  const word = token.replace(/[^\p{L}\p{N}'-]+/gu, '');
  return word.length >= 2 ? word.slice(0, 40) : null;
}

type Partial = Omit<ParsedQuery, 'words'>;

/** `21M.1SL.TZ1.22` and its relatives. Returns null when the token is not one. */
function parseIbCode(token: string): Partial | null {
  const segments = token.split('.').filter((segment) => segment !== '');
  const head = /^(\d{2})([MN])$/i.exec(segments[0] ?? '');
  if (!head) return null;

  const out: Partial = {
    year: 2000 + Number(head[1]),
    month: head[2].toUpperCase() === 'N' ? 'November' : 'May',
  };
  for (const segment of segments.slice(1)) {
    let match: RegExpExecArray | null;
    if ((match = /^(\d)([AB])?(HLSL|HL|SL)?$/i.exec(segment))) {
      if (out.paperNumber === undefined) {
        out.paperNumber = Number(match[1]);
        if (match[2]) out.variant = match[2].toUpperCase().charCodeAt(0) - 64;
        if (match[3]) out.level = match[3].toUpperCase() as ParsedQuery['level'];
        continue;
      }
      // A second bare number is the question: "21M.1.SL.TZ1.22".
      if (/^\d+$/.test(segment)) {
        out.question = Number(segment);
        continue;
      }
      return null;
    } else if ((match = /^(HLSL|HL|SL)$/i.exec(segment))) {
      out.level = match[1].toUpperCase() as ParsedQuery['level'];
    } else if ((match = /^TZ(\d)$/i.exec(segment))) {
      out.timezone = match[1] === '0' ? null : `TZ${match[1]}`;
    } else if (/^\d+$/.test(segment)) {
      out.question = Number(segment);
    } else {
      return null;
    }
  }
  return out;
}

/** `0625/42/M/J/21` */
function parseCaieSlash(token: string): Partial | null {
  const match = /^(\d{4})\/(\d)(\d)?\/([MOF])\/([JNM])\/(\d{2})$/i.exec(token);
  if (!match) return null;
  const letters = `${match[4]}${match[5]}`.toUpperCase();
  const month: Month | null = letters === 'MJ' ? 'May' : letters === 'ON' ? 'November' : letters === 'FM' ? 'February' : null;
  if (!month) return null;
  return {
    syllabus: match[1],
    paperNumber: Number(match[2]),
    ...(match[3] ? { variant: Number(match[3]) } : {}),
    month,
    year: 2000 + Number(match[6]),
  };
}

/** `0625_s21_qp_42` */
function parseCaieFile(token: string): Partial | null {
  const match = /^(\d{4})_([smw])(\d{2})_(?:qp|ms|in)_(\d)(\d)?$/i.exec(token);
  if (!match) return null;
  const session = CAIE_SESSION[match[2].toLowerCase()];
  return {
    syllabus: match[1],
    month: session.month,
    year: 2000 + Number(match[3]),
    paperNumber: Number(match[4]),
    ...(match[5] ? { variant: Number(match[5]) } : {}),
  };
}

export function parseQuestionQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { words: [] };
  const tokens = tokenize(query.slice(0, 200));

  const take = (partial: Partial) => {
    for (const [key, value] of Object.entries(partial)) {
      // The first mention wins: "2023 2024" is a typo, not a request for both.
      if ((parsed as Record<string, unknown>)[key] === undefined) {
        (parsed as Record<string, unknown>)[key] = value;
      }
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let match: RegExpExecArray | null;

    const whole = parseIbCode(token) ?? parseCaieSlash(token) ?? parseCaieFile(token);
    if (whole) {
      take(whole);
      continue;
    }

    // "Q3", "q 3", "Q3(a)" -- the part letters are ignored: the list is root questions.
    if ((match = /^q\.?(\d{1,3})(?:\(?[a-z]{1,2}\)?(?:\([ivx]+\))?)?$/i.exec(token))) {
      take({ question: Number(match[1]) });
      continue;
    }
    if (/^q$/i.test(token) && /^\d{1,3}$/.test(tokens[index + 1] ?? '')) {
      take({ question: Number(tokens[index + 1]) });
      index += 1;
      continue;
    }
    // "paper 2", "p2", "P 2"
    if ((match = /^p(?:aper)?\.?(\d)$/i.exec(token))) {
      take({ paperNumber: Number(match[1]) });
      continue;
    }
    if (/^(paper|p)$/i.test(token) && /^\d$/.test(tokens[index + 1] ?? '')) {
      take({ paperNumber: Number(tokens[index + 1]) });
      index += 1;
      continue;
    }
    // "1SL", "2HL", "1ASL"
    if ((match = /^(\d)([AB])?(HLSL|HL|SL)$/i.exec(token))) {
      take({
        paperNumber: Number(match[1]),
        ...(match[2] ? { variant: match[2].toUpperCase().charCodeAt(0) - 64 } : {}),
        level: match[3].toUpperCase() as ParsedQuery['level'],
      });
      continue;
    }
    if ((match = /^(HLSL|HL|SL)$/i.exec(token))) {
      take({ level: match[1].toUpperCase() as ParsedQuery['level'] });
      continue;
    }
    if ((match = /^TZ(\d)$/i.exec(token))) {
      take({ timezone: match[1] === '0' ? null : `TZ${match[1]}` });
      continue;
    }
    // "0625": a syllabus. "2023": a year. Anything else four digits long is a word.
    if (/^20\d{2}$/.test(token)) {
      take({ year: Number(token) });
      continue;
    }
    if (/^\d{4}$/.test(token)) {
      take({ syllabus: token });
      continue;
    }
    // "May" / "Nov"
    const month = MONTH_WORDS.find(([pattern]) => pattern.test(token));
    if (month) {
      take({ month: month[1] });
      continue;
    }
    // A bare number is a question number: `22`.
    if (/^\d{1,3}$/.test(token)) {
      take({ question: Number(token) });
      continue;
    }

    const word = cleanWord(token);
    if (word) parsed.words.push(word);
  }

  // More than a handful of words stops being a search and starts being a paste.
  parsed.words = parsed.words.slice(0, 4);
  return parsed;
}

/** True when the query carries nothing the list can act on. */
export function isEmptyQuery(parsed: ParsedQuery): boolean {
  const { words, ...rest } = parsed;
  return words.length === 0 && Object.values(rest).every((value) => value === undefined);
}

export type SubjectForCheck = { board: string; code: string; level: string | null; name: string };

/**
 * Does the query contradict the subject that is selected?
 *
 * Without this, an `HL` code typed under an SL subject (or a 0625 code under
 * Physics 9702) just returned an empty list, and "No questions match" reads as
 * "that question does not exist". Naming the conflict tells the student what to
 * change.
 */
export function conflictWithSubject(parsed: ParsedQuery, subject: SubjectForCheck): string | null {
  if (parsed.syllabus && subject.board !== 'IB' && parsed.syllabus !== subject.code) {
    return `${parsed.syllabus} is a different syllabus from ${subject.name} (${subject.code}). Pick that subject, or clear the code.`;
  }
  if (parsed.syllabus && subject.board === 'IB') {
    return `${parsed.syllabus} is a Cambridge syllabus code, but ${subject.name} is an IB subject.`;
  }
  if (parsed.level && subject.board === 'IB' && subject.level && subject.level !== 'HLSL' && parsed.level !== 'HLSL') {
    if (parsed.level !== subject.level) {
      return `That code is for ${parsed.level}, but ${subject.name} is ${subject.level}. Pick the ${parsed.level} subject, or remove ${parsed.level} from the search.`;
    }
  }
  if (parsed.month && storedSession(subject.board, parsed.month) === null) {
    return `${subject.name} has no February/March sitting.`;
  }
  return null;
}
