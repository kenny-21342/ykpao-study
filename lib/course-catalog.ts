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
 * Every entry here must name a `subjects.code` that actually exists, or the
 * course onboards a student into an empty dashboard. An earlier version of this
 * catalogue was written against the published Cambridge syllabus codes while
 * the ingest pipeline collected a different set, so six courses (0580, 0606,
 * 0475, 0450, 9700, 9701) pointed at subjects that were never ingested and four
 * ingested subjects had no course at all. The lists below are derived from what
 * is in the database; re-derive them if the ingest set changes.
 */
export const COURSE_CATALOG: CatalogCourse[] = [
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
  cambridge('Mathematics', 'MATH-AL', 'Mathematics', 'A Level', '9709'),
  cambridge('Physics', 'PHYS-AL', 'Physics', 'A Level', '9702'),
  cambridge('Economics', 'ECON-AL', 'Economics', 'A Level', '9708'),
  cambridge('Further Mathematics', 'FMATH-AL', 'Mathematics', 'A Level', '9231'),
  // Two live Computer Science syllabuses: 9618 is current, 9608 was examined
  // through 2021 but still has 309 papers worth practising, so both appear and
  // the names disambiguate them.
  cambridge('Computer Science (9618)', 'CS-AL', 'Computer Science', 'A Level', '9618'),
  cambridge('Computer Science (9608, retired)', 'CS-9608-AL', 'Computer Science', 'A Level', '9608'),

  // The IB catalogue deliberately omits six subjects that exist in `subjects`
  // but should not be enrollable: Mathematics and Mathematical Studies (retired
  // syllabi superseded by AA/AI), History Route 1 and Route 2 (pre-2017), and
  // Nature of Science and Brazilian Social Studies (8 and 2 papers, not
  // subjects anyone sits).
  ib('Biology', 'BIO-IB', 'Biology', 'ib-biology'),
  ib('Chemistry', 'CHEM-IB', 'Chemistry', 'ib-chemistry'),
  ib('Physics', 'PHYS-IB', 'Physics', 'ib-physics'),
  ib('Sports, Exercise and Health Science', 'SEHS-IB', 'Science', 'ib-sports-exercise-and-health-science'),
  ib('Environmental Systems and Societies', 'ESS-IB', 'Science', 'ib-environmental-systems-and-societies'),
  ib('Mathematics: Analysis and Approaches', 'MATH-AA-IB', 'Mathematics', 'ib-mathematics-analysis-and-approaches'),
  ib('Mathematics: Applications and Interpretation', 'MATH-AI-IB', 'Mathematics', 'ib-mathematics-applications-and-interpretation'),
  ib('Further Mathematics', 'FMATH-IB', 'Mathematics', 'ib-further-mathematics'),
  ib('Computer Science', 'CS-IB', 'Computer Science', 'ib-computer-science'),
  ib('Information Technology in a Global Society', 'ITGS-IB', 'Computer Science', 'ib-itgs'),
  ib('Economics', 'ECON-IB', 'Economics', 'ib-economics'),
  ib('Business Management', 'BUS-IB', 'Business', 'ib-business-management'),
  ib('Geography', 'GEOG-IB', 'Geography', 'ib-geography'),
  ib('History', 'HIST-IB', 'History', 'ib-history'),
  ib('Psychology', 'PSYCH-IB', 'Psychology', 'ib-psychology'),
  ib('Philosophy', 'PHIL-IB', 'Philosophy', 'ib-philosophy'),
  ib('English A: Literature', 'ENG-LIT-IB', 'English', 'ib-english-a-literature'),
  ib('English A: Language and Literature', 'ENG-LANG-LIT-IB', 'English', 'ib-english-a-language-and-literature'),
  ib('Chinese A: Literature', 'CHIN-LIT-IB', 'Chinese', 'ib-chinese-a-literature'),
  ib('Chinese A: Language and Literature', 'CHIN-LANG-LIT-IB', 'Chinese', 'ib-chinese-a-language-and-literature'),
  ib('Music', 'MUSIC-IB', 'Music', 'ib-music'),
];

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
