/**
 * The catalogue itself: what the site publishes, and the pure helpers over it.
 *
 * Split out of `course-catalog.ts` so it can be imported without dragging in
 * `lib/prisma`. The sync half of that module needs a database; this half is a
 * constant and three functions over it, and both the analytics helpers and the
 * test runner need it without one. `course-catalog.ts` re-exports everything
 * here, so no existing import had to change.
 */

export type CatalogCourse = {
  name: string;
  code: string;
  subject: string;
  level: string;
  description: string;
  scopes: Array<{
    board: string;
    qualification: string;
    level: string;
    subjectCode: string;
  }>;
};

const cambridge = (
  name: string,
  code: string,
  subject: string,
  level: 'IGCSE' | 'A Level',
  subjectCode: string,
): CatalogCourse => ({
  name,
  code,
  subject,
  level,
  description: `Cambridge ${level} ${name}`,
  scopes: [{
    board: 'Cambridge',
    qualification: level === 'IGCSE' ? 'Cambridge IGCSE' : 'Cambridge AS & A Level',
    level,
    subjectCode,
  }],
});

/**
 * IB courses key off the `ib-*` codes in `subjects.code`, not numeric syllabus
 * codes -- the IB does not publish Cambridge-style four-digit codes, so the
 * ingest pipeline slugified subject names instead. `PaperViewer` recognises the
 * `ib-` prefix and skips RAG subject filtering for it.
 */
const ib = (
  name: string,
  code: string,
  subject: string,
  subjectCode: string,
): CatalogCourse => ({
  name,
  code,
  subject,
  level: 'IB',
  description: `IB Diploma Programme ${name}`,
  scopes: [{
    board: 'IB',
    qualification: 'Diploma Programme',
    level: 'IB',
    subjectCode,
  }],
});

/**
 * Everything the site publishes.
 *
 * Mostly the YK Pao syllabus, confirmed 24 Aug 2026, plus Cambridge A Level,
 * which the school does not teach and which is kept on purpose anyway. Two
 * rules, both easy to break by accident:
 *
 * 1. Every entry must name a `subjects.code` that exists, or the course
 *    onboards a student into an empty dashboard.
 * 2. Removing a course is close to irreversible in practice. No paper data is
 *    deleted, but the sources these came from are now gated, so anything
 *    dropped here cannot simply be re-collected.
 *
 * Absent on purpose:
 *   - IB Chinese A: Literature. The school teaches Chinese A Language and
 *     Literature only.
 *   - IB ITGS and IB Further Mathematics. Not on the timetable.
 *   - IB Mathematics and Mathematical Studies, History Route 1 and Route 2,
 *     Nature of Science, Brazilian Social Studies. Retired or vestigial.
 *
 * Still absent, and why:
 *   - IB Chinese B and English B. Papers exist; the archive the IB corpus came
 *     from did not contain them.
 *   - IB Visual Arts and Theatre. Group 6 arts subjects are assessed by
 *     portfolio and performance -- there is no written paper to ingest.
 */
export const COURSE_CATALOG: CatalogCourse[] = [
  // ---- Cambridge IGCSE, as taught (10 of the 17 on the syllabus) ----
  cambridge('Biology', 'BIO-IG', 'Biology', 'IGCSE', '0610'),
  cambridge('Chemistry', 'CHEM-IG', 'Chemistry', 'IGCSE', '0620'),
  cambridge('Physics', 'PHYS-IG', 'Physics', 'IGCSE', '0625'),
  cambridge('Mathematics (International)', 'MATH-INTL-IG', 'Mathematics', 'IGCSE', '0607'),
  cambridge('Geography', 'GEOG-IG', 'Geography', 'IGCSE', '0460'),
  cambridge('English First Language', 'ENG-LANG-IG', 'English', 'IGCSE', '0500'),
  cambridge('History', 'HIST-IG', 'History', 'IGCSE', '0470'),
  cambridge('Economics', 'ECON-IG', 'Economics', 'IGCSE', '0455'),
  cambridge('Computer Science', 'CS-IG', 'Computer Science', 'IGCSE', '0478'),
  cambridge('Chinese First Language', 'CHIN-LANG-IG', 'Chinese', 'IGCSE', '0509'),
  // Ingested 24 Aug 2026 from papacambridge, completing the IGCSE syllabus.
  cambridge('Literature in English', 'ENG-LIT-IG', 'English', 'IGCSE', '0475'),
  cambridge('Additional Mathematics', 'ADD-MATH-IG', 'Mathematics', 'IGCSE', '0606'),
  cambridge('Business Studies', 'BUS-IG', 'Business', 'IGCSE', '0450'),
  cambridge('Drama', 'DRAMA-IG', 'Drama', 'IGCSE', '0411'),
  cambridge('Music', 'MUSIC-IG', 'Music', 'IGCSE', '0410'),
  cambridge('Physical Education', 'PE-IG', 'Physical Education', 'IGCSE', '0413'),
  // Art & Design stops at 2019: syllabus 0400 was replaced by a newer code,
  // so 27 papers is the complete run rather than a partial download.
  cambridge('Art & Design', 'ART-IG', 'Art & Design', 'IGCSE', '0400'),

  // ---- Cambridge A Level ----
  // Not taught at the school. Kept deliberately: the corpus was collected on
  // purpose, it is in active personal use, and the source it came from is now
  // behind a bot challenge, so removing it is effectively permanent.
  cambridge('Mathematics', 'MATH-AL', 'Mathematics', 'A Level', '9709'),
  cambridge('Physics', 'PHYS-AL', 'Physics', 'A Level', '9702'),
  cambridge('Economics', 'ECON-AL', 'Economics', 'A Level', '9708'),
  cambridge('Further Mathematics', 'FMATH-AL', 'Mathematics', 'A Level', '9231'),
  // Two live syllabuses: 9618 is current, 9608 was examined through 2021 but
  // still has 309 papers worth practising, so both appear and the names
  // disambiguate them.
  cambridge('Computer Science (9618)', 'CS-AL', 'Computer Science', 'A Level', '9618'),
  cambridge('Computer Science (9608, retired)', 'CS-9608-AL', 'Computer Science', 'A Level', '9608'),

  // ---- IB Diploma, as taught (18 of the 22 on the syllabus) ----
  ib('Biology', 'BIO-IB', 'Biology', 'ib-biology'),
  ib('Chemistry', 'CHEM-IB', 'Chemistry', 'ib-chemistry'),
  ib('Physics', 'PHYS-IB', 'Physics', 'ib-physics'),
  ib('Sports, Exercise and Health Science', 'SEHS-IB', 'Science', 'ib-sports-exercise-and-health-science'),
  ib('Environmental Systems and Societies', 'ESS-IB', 'Science', 'ib-environmental-systems-and-societies'),
  ib('Mathematics: Analysis and Approaches', 'MATH-AA-IB', 'Mathematics', 'ib-mathematics-analysis-and-approaches'),
  ib('Mathematics: Applications and Interpretation', 'MATH-AI-IB', 'Mathematics', 'ib-mathematics-applications-and-interpretation'),
  ib('Computer Science', 'CS-IB', 'Computer Science', 'ib-computer-science'),
  ib('Economics', 'ECON-IB', 'Economics', 'ib-economics'),
  ib('Business Management', 'BUS-IB', 'Business', 'ib-business-management'),
  ib('Geography', 'GEOG-IB', 'Geography', 'ib-geography'),
  ib('History', 'HIST-IB', 'History', 'ib-history'),
  ib('Psychology', 'PSYCH-IB', 'Psychology', 'ib-psychology'),
  ib('Philosophy', 'PHIL-IB', 'Philosophy', 'ib-philosophy'),
  ib('English A: Literature', 'ENG-LIT-IB', 'English', 'ib-english-a-literature'),
  ib('English A: Language and Literature', 'ENG-LANG-LIT-IB', 'English', 'ib-english-a-language-and-literature'),
  ib('Chinese A: Language and Literature', 'CHIN-LANG-LIT-IB', 'Chinese', 'ib-chinese-a-language-and-literature'),
  ib('Music', 'MUSIC-IB', 'Music', 'ib-music'),
];

/**
 * The human name for a syllabus code, or null when the catalog lacks it.
 *
 * The question bank stores CAIE subjects as "CAIE 0625": the extraction
 * pipeline has only the filename to go on, and a filename carries the code, not
 * the subject. Reading the name from here lets a student see "Physics" without
 * the corpus being rebuilt. Codes outside the catalog — retired syllabuses, A
 * Level subjects nobody is enrolled in — fall back to what was stored.
 */
export function subjectNameForCode(subjectCode: string): string | null {
  for (const entry of COURSE_CATALOG) {
    for (const scope of entry.scopes) {
      if (scope.subjectCode === subjectCode) return entry.name;
    }
  }
  return null;
}

/**
 * The `subjects.code` values the site publishes.
 *
 * The catalogue is the single definition of what exists here, so the paper
 * browser filters on this rather than showing every subject that happens to
 * have rows -- which is what surfaced the retired IB syllabuses nobody sits.
 * Named for what it is: published, not taught. A Level is published and not
 * taught.
 */
export function publishedSubjectCodes(): Set<string> {
  return new Set(
    COURSE_CATALOG.flatMap((entry) => entry.scopes.map((scope) => scope.subjectCode)),
  );
}
