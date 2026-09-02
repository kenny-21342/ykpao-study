import { prisma } from '@/lib/prisma';
import { COURSE_CATALOG } from './course-catalog-data';

export type { CatalogCourse } from './course-catalog-data';
export {
  COURSE_CATALOG,
  subjectNameForCode,
  publishedSubjectCodes,
} from './course-catalog-data';


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
/**
 * Guards the catalogue sync so it runs once per process, not once per request.
 * (The comment above describes what the sync itself does.)
 *
 * `COURSE_CATALOG` is a constant in this file, so it can only change when the
 * code changes -- and that means a new deployment and a fresh process. Running
 * the sync on every request bought nothing and cost 47 course upserts plus 47
 * scope upserts, sequentially, against Neon: the pre-launch sweep measured
 * /api/onboarding at 4.1s and /api/me/courses at 4.3s, which is almost
 * entirely this. Onboarding is the first request a new student ever makes.
 *
 * Null again on failure, so a transient database error does not leave the
 * catalogue permanently unsynced for the life of the instance.
 */
let catalogSync: Promise<void> | null = null;

export async function ensureCourseCatalog(): Promise<void> {
  catalogSync ??= syncCourseCatalog().catch((error) => {
    catalogSync = null;
    throw error;
  });
  return catalogSync;
}

/** Test seam: forget that the catalogue was synced. */
export function resetCourseCatalogSync(): void {
  catalogSync = null;
}

async function syncCourseCatalog() {
  await prisma.course.updateMany({
    where: {
      catalogManaged: true,
      code: { notIn: COURSE_CATALOG.map((entry) => entry.code) },
    },
    data: { catalogManaged: false },
  });

  // Bounded concurrency rather than a bare Promise.all: the entries are
  // independent, but 94 simultaneous queries against a 0.25 CU instance is a
  // different kind of rude. Eight at a time turns ~4s of serial round trips
  // into well under one.
  const CONCURRENCY = 8;
  const queue = [...COURSE_CATALOG];

  async function worker() {
    for (let entry = queue.pop(); entry; entry = queue.pop()) {
      await syncCourseEntry(entry);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function syncCourseEntry(entry: (typeof COURSE_CATALOG)[number]) {
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
