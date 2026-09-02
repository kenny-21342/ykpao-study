import { COURSE_CATALOG, subjectNameForCode } from './course-catalog-data.ts';

/**
 * Shared shape for reading the crop-first bank into the analytics surfaces.
 *
 * The weakness heatmap, the learning overview and the study-plan generator were
 * all written against `PastPaperQuestion` / `PastPaperAttempt` and never read
 * `BankQuestionAttempt` at all. The bank is the corpus students actually
 * practise on -- 66,758 published questions -- and mock exams have been drawn
 * from it since `mock_exam_items_from_bank`, so an exam built from the bank
 * contributed nothing to any of them: `MockExamItem.bankQuestionId` was set,
 * `questionId` was null, and every reader skipped the row.
 *
 * This is the join and the normalisation, in one place, so the three routes
 * agree on what a subject and a topic are called.
 */

/** The subject/paper/topic joins every analytics read needs off a bank question. */
export const bankAnalyticsQuestionSelect = {
  id: true,
  bodyMd: true,
  totalMarks: true,
  paper: {
    select: {
      subject: { select: { name: true, code: true, level: true, board: true } },
    },
  },
  topics: {
    select: { topic: { select: { name: true } } },
    orderBy: { confidence: 'desc' as const },
    take: 1,
  },
  tags: {
    select: { tag: { select: { label: true } } },
    orderBy: { confidence: 'desc' as const },
    take: 1,
  },
} as const;

export type BankAnalyticsQuestion = {
  id: number;
  bodyMd: string;
  totalMarks: number | null;
  paper: { subject: { name: string; code: string; level: string | null; board: string } };
  topics: { topic: { name: string } }[];
  tags: { tag: { label: string } }[];
};

/**
 * The subject name to aggregate under.
 *
 * Deliberately *not* `bankSubjectName`, which appends a qualification --
 * "Biology (IGCSE)". That is right for a paper browser and wrong here: it would
 * split one student's Biology into two rows, one per corpus, and neither would
 * show their real accuracy.
 */
export function analyticsSubjectName(subject: {
  name: string;
  code: string;
}): string {
  return subjectNameForCode(subject.code) ?? subject.name ?? 'General';
}

/**
 * The topic to aggregate under.
 *
 * `bank_question_topics` is empty across the whole corpus until the syllabus
 * registries land, so this falls back to the highest-confidence search tag and
 * then to 'General'. A subject with no topics still aggregates at subject
 * level, which is what the heatmap needs to stop being blank.
 */
export function bankTopicName(question: {
  topics: { topic: { name: string } }[];
  tags: { tag: { label: string } }[];
}): string {
  return question.topics[0]?.topic.name ?? question.tags[0]?.tag.label ?? 'General';
}

/** Scope filter for bank attempts, mirroring `ppWhere` in the dashboard route. */
export function bankAttemptScopeWhere(
  effectiveScope: string,
  bankSubjectCodes: string[],
) {
  return effectiveScope === 'enrolled'
    ? { question: { paper: { subject: { code: { in: bankSubjectCodes } } } } }
    : {};
}

/**
 * Bank subject codes for a set of display subject names.
 *
 * The analytics surfaces aggregate under the display name ("Biology"), but the
 * bank stores codes ("0610", "ib-biology"). This is the way back, and it keeps
 * the `ib-` stripping convention `toBankSubjectCodes` established -- the corpus
 * carries some IB subjects with the prefix and some without.
 */
export function bankSubjectCodesForNames(names: string[]): string[] {
  const wanted = new Set(names);
  const codes = new Set<string>();
  for (const entry of COURSE_CATALOG) {
    if (!wanted.has(entry.name)) continue;
    for (const scope of entry.scopes) {
      codes.add(scope.subjectCode);
      if (scope.subjectCode.startsWith('ib-')) codes.add(scope.subjectCode.slice(3));
    }
  }
  return [...codes];
}
