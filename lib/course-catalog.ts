import { prisma } from '@/lib/prisma';

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
 * On the syllabus but not yet ingested, so they cannot be listed until papers
 * exist: IGCSE 0475, 0606, 0450, 0400 (Art & Design), 0411 (Drama),
 * 0410 (Music), 0413 (PE); IB Chinese B, English B, Visual Arts, Theatre.
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

/**
 * Idempotently materialize the controlled catalog; clients never create it.
 *
 * Also retires courses that used to be in the catalog and no longer are. The
 * upserts alone cannot do this -- a removed entry would leave its row behind
 * still flagged `catalogManaged`, so it would keep appearing in the picker. We
 * clear the flag rather than delete: the onboarding query also matches courses
 * the user is enrolled in, so anyone already studying a retired course keeps it
 * while it disappears for everyone else.
 */
export async function ensureCourseCatalog() {
  await prisma.course.updateMany({
    where: {
      catalogManaged: true,
      code: { notIn: COURSE_CATALOG.map((entry) => entry.code) },
    },
    data: { catalogManaged: false },
  });

  for (const entry of COURSE_CATALOG) {
    const course = await prisma.course.upsert({
      where: { code: entry.code },
      create: {
        name: entry.name,
        code: entry.code,
        subject: entry.subject,
        level: entry.level,
        description: entry.description,
        catalogManaged: true,
      },
      update: {
        name: entry.name,
        subject: entry.subject,
        level: entry.level,
        description: entry.description,
        catalogManaged: true,
      },
    });
    for (const scope of entry.scopes) {
      await prisma.courseCurriculumScope.upsert({
        where: {
          courseId_board_qualification_level_subjectCode: {
            courseId: course.id,
            ...scope,
          },
        },
        create: { courseId: course.id, ...scope },
        update: {},
      });
    }
  }
}
