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

export const COURSE_CATALOG: CatalogCourse[] = [
  cambridge('Mathematics', 'MATH-IG', 'Mathematics', 'IGCSE', '0580'),
  cambridge('Additional Mathematics', 'ADD-MATH-IG', 'Mathematics', 'IGCSE', '0606'),
  cambridge('Physics', 'PHYS-IG', 'Physics', 'IGCSE', '0625'),
  cambridge('Chemistry', 'CHEM-IG', 'Chemistry', 'IGCSE', '0620'),
  cambridge('Biology', 'BIO-IG', 'Biology', 'IGCSE', '0610'),
  cambridge('Economics', 'ECON-IG', 'Economics', 'IGCSE', '0455'),
  cambridge('Computer Science', 'CS-IG', 'Computer Science', 'IGCSE', '0478'),
  cambridge('English Language', 'ENG-LANG-IG', 'English', 'IGCSE', '0500'),
  cambridge('English Literature', 'ENG-LIT-IG', 'English', 'IGCSE', '0475'),
  cambridge('Geography', 'GEOG-IG', 'Geography', 'IGCSE', '0460'),
  cambridge('History', 'HIST-IG', 'History', 'IGCSE', '0470'),
  cambridge('Business Studies', 'BUS-IG', 'Business', 'IGCSE', '0450'),
  cambridge('Mathematics', 'MATH-AL', 'Mathematics', 'A Level', '9709'),
  cambridge('Further Mathematics', 'FMATH-AL', 'Mathematics', 'A Level', '9231'),
  cambridge('Physics', 'PHYS-AL', 'Physics', 'A Level', '9702'),
  cambridge('Chemistry', 'CHEM-AL', 'Chemistry', 'A Level', '9701'),
  cambridge('Biology', 'BIO-AL', 'Biology', 'A Level', '9700'),
  cambridge('Economics', 'ECON-AL', 'Economics', 'A Level', '9708'),
];

/** Idempotently materialize the controlled catalog; clients never create it. */
export async function ensureCourseCatalog() {
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
