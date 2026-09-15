'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Skeleton, SkeletonRegion } from './Skeleton';
import { ArrowRight, BookOpen, ClipboardList, Library, Plus, Settings2 } from 'lucide-react';

/**
 * The learner's own subjects, on the dashboard, each one a way in.
 *
 * Course enrolment used to be reachable only from first-login onboarding and
 * a panel in Account, so after day one a student had no subject-shaped
 * entrance anywhere: every route in started from "Past Papers" and made them
 * re-pick the curriculum and subject they had already told us about. A tester
 * asked for this directly, comparing it to the subject grid on Save My Exams.
 *
 * The Past Papers link carries a real filter, because a course scope holds the
 * board, qualification and subject code the browse cascade reads from the URL.
 * Practice and Mock exams open their tabs unfiltered -- those surfaces have no
 * subject parameter, and a link that silently ignored half of itself would be
 * worse than an honest one.
 */

type Scope = {
  board: string;
  qualification: string;
  level: string;
  subjectCode: string;
};

type Course = {
  id: string;
  name: string;
  subject: string;
  level: string;
  scopes: Scope[];
  targetGrade: string | null;
};

const CARD =
  'group flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4 transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:border-gray-700 dark:bg-gray-950 dark:hover:border-emerald-500/50 dark:hover:bg-emerald-950/30';

/** The browse cascade reads `curriculum` as `board|qualification`. */
function papersHref(scope: Scope | undefined): string {
  if (!scope) return '/papers';
  const params = new URLSearchParams({
    curriculum: `${scope.board}|${scope.qualification}`,
    subject: scope.subjectCode,
  });
  return `/papers?${params.toString()}`;
}

export default function CourseShortcuts({
  onOpenPractice,
  onOpenMockExams,
}: {
  onOpenPractice: () => void;
  onOpenMockExams: () => void;
}) {
  const [courses, setCourses] = useState<Course[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me/courses', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data) setCourses(data.context?.enrolledCourses ?? []);
      })
      .catch(() => {
        // A dashboard section that cannot load its own data simply does not
        // render; it is not worth an error banner over the day's study plan.
      });
    return () => controller.abort();
  }, []);

  // Returning null while loading collapsed the section to nothing and then
  // pushed everything below it down when the fetch landed. A placeholder of
  // roughly the right height keeps the dashboard still.
  if (courses === null) {
    return (
      <SkeletonRegion
        label="Loading your courses"
        className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 md:p-6"
      >
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-2 h-3 w-64" />
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </SkeletonRegion>
    );
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Your courses</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {courses.length > 0
              ? 'Jump straight into a subject.'
              : 'Pick your subjects once and they will be waiting here.'}
          </p>
        </div>
        <Link
          href="/account"
          className="inline-flex items-center gap-2 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:border-emerald-300 hover:text-emerald-700 dark:border-gray-700 dark:text-gray-300 dark:hover:border-emerald-500/50"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {courses.length > 0 ? 'Edit courses' : 'Choose courses'}
        </Link>
      </div>

      {courses.length === 0 ? (
        <Link
          href="/account"
          className="mt-4 flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 py-10 text-gray-500 transition-colors hover:border-emerald-300 hover:text-emerald-700 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-400"
        >
          <Plus className="h-8 w-8 opacity-40" />
          <p className="mt-3 text-sm font-medium">No subjects yet</p>
          <p className="mt-1 text-xs">Add the ones you are sitting to get shortcuts here.</p>
        </Link>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {courses.map((course) => {
            const scope = course.scopes[0];
            return (
              <div key={course.id} className={CARD}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {/*
                      The course name, not its subject. `subject` is a grouping
                      key and several courses share one: a student taking both
                      IGCSE English First Language and Literature in English
                      saw two cards both reading "English / IGCSE", with no way
                      to tell which was which or that they weren't a duplicate.
                      It is always set, so the old `subject || name` never once
                      reached the name.
                    */}
                    <p className="truncate font-semibold text-gray-900 dark:text-gray-100" title={course.name || course.subject}>
                      {course.name || course.subject}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                      {course.level}
                      {course.targetGrade ? ` · target ${course.targetGrade}` : ''}
                    </p>
                  </div>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                    <BookOpen className="h-4.5 w-4.5" />
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <Link
                    href={papersHref(scope)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:text-emerald-700 dark:bg-gray-900 dark:text-gray-300"
                  >
                    <Library className="h-3.5 w-3.5" />
                    Past papers
                    <ArrowRight className="h-3 w-3 text-gray-400" />
                  </Link>
                  <button
                    onClick={onOpenPractice}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:text-emerald-700 dark:bg-gray-900 dark:text-gray-300"
                  >
                    <BookOpen className="h-3.5 w-3.5" />
                    Practice
                  </button>
                  <button
                    onClick={onOpenMockExams}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:text-emerald-700 dark:bg-gray-900 dark:text-gray-300"
                  >
                    <ClipboardList className="h-3.5 w-3.5" />
                    Mock exam
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
