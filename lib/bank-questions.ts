/**
 * Reading the crop-first question bank.
 *
 * A bank question is an image, not text: the extraction pipeline renders the
 * original question as a series of strips, in reading order, with the answer
 * space and page furniture removed. `bodyMd` may be empty — a crop-only run
 * writes rows with no transcription at all — so nothing here depends on it.
 *
 * Strips matter rather than `screenshotId`: that column holds only the first
 * one, which for 89% of questions is the top fragment of the image.
 */
import { subjectNameForCode } from '@/lib/course-catalog';
import { prisma } from '@/lib/prisma';
import { bankAssetKey } from '@/lib/storage/keys';

export type BankStrip = {
  url: string;
  width: number | null;
  height: number | null;
  page: number;
};

export type BankQuestionView = {
  id: number;
  rootNumber: number;
  totalMarks: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  strips: BankStrip[];
  markScheme: { id: number; strips: BankStrip[]; answerLetter: string | null } | null;
  /**
   * Whether a transcription exists for this question.
   *
   * The crop-only corpus run produced 68,849 published questions at no model
   * cost, and every one of them has an empty `bodyMd`: the strips are the
   * question. Transcription is a separate, paid pass that fills `bodyMd` in
   * later, subject by subject.
   *
   * Everything that reasons over a question rather than displaying it — hints,
   * AI grading, search — needs that text and cannot work without it. So the
   * features are gated on this flag and hidden when it is false, rather than
   * offered and then failing on an empty prompt. As transcription lands, they
   * appear for the questions that have it, with no further change here.
   */
  hasText: boolean;
  /**
   * The command terms this question uses, as slugs into `COMMAND_TERMS`.
   *
   * Shown beside the question so a student knows what is actually being asked
   * of them before they answer -- "evaluate" and "describe" are marked against
   * different criteria, and answering one as if it said the other is the most
   * common avoidable way to lose marks.
   *
   * Empty until `scripts/backfill-command-terms.ts` has run for the subject.
   */
  commandTerms: string[];
};

export type BankPaperView = {
  id: number;
  /** Display name, e.g. "Biology (IGCSE)". */
  subject: string;
  /** Syllabus code, e.g. "0610". Distinct from `subject`: anything that
   *  scopes a query -- RAG retrieval, course matching -- wants this one. */
  subjectCode: string;
  board: string;
  year: number;
  session: string;
  paperNumber: number;
  variant: number;
  questions: BankQuestionView[];
};

/**
 * What a student should see for a subject.
 *
 * Two problems, both visible the moment the index lists 6,406 papers.
 *
 * The pipeline stores CAIE subjects as "CAIE 0625": it parses filenames, and a
 * filename carries the syllabus code, not the subject. The course catalog maps
 * code to name, so that is resolved here rather than by rebuilding the corpus.
 * IB papers already carry a real name and keep it.
 *
 * And the same name covers several qualifications — Physics is both 0625 and
 * 9702, History is IGCSE and IB — so without the level the list shows repeated
 * identical entries with no way to tell them apart.
 */
export function bankSubjectName(subject: {
  name: string;
  code: string;
  level: string | null;
  board: string;
}): string {
  const name = subjectNameForCode(subject.code) ?? subject.name;
  const qualification = qualificationLabel(subject.board, subject.level);
  return qualification ? `${name} (${qualification})` : name;
}

/** "igcse" and "HL" are how the pipeline stores it; neither is what to show. */
function qualificationLabel(board: string, level: string | null): string | null {
  if (board === 'IB') {
    if (level === 'HL' || level === 'SL') return `IB ${level}`;
    return 'IB';
  }
  if (level === 'igcse') return 'IGCSE';
  if (level === 'a-level') return 'A Level';
  return null;
}

type StripRow = {
  page: number;
  asset: { sha256: string; width: number | null; height: number | null };
};

/**
 * Turn stored strip rows into servable URLs.
 *
 * A row whose sha256 is malformed is dropped rather than rendered as a broken
 * image: `bankAssetKey` returns null for anything that is not a digest.
 */
function toStrips(rows: StripRow[]): BankStrip[] {
  const strips: BankStrip[] = [];
  for (const row of rows) {
    const key = bankAssetKey(row.asset.sha256);
    if (!key) continue;
    strips.push({
      url: `/${key}`,
      width: row.asset.width,
      height: row.asset.height,
      page: row.page,
    });
  }
  return strips;
}

/**
 * One paper's questions, in order, each with its full crop.
 *
 * Only published rows are returned. A question sits at `needs_review` when the
 * crop QA found the image itself wrong — a cut-off question number, a missing
 * Marks column, an erased stem — and showing a student a known-bad crop is
 * worse than showing them nothing.
 */
export async function getBankPaper(paperId: number): Promise<BankPaperView | null> {
  const paper = await prisma.bankPaper.findUnique({
    where: { id: paperId },
    include: {
      subject: true,
      questions: {
        where: { status: 'published' },
        orderBy: { rootNumber: 'asc' },
        include: {
          strips: {
            orderBy: { ordering: 'asc' },
            include: { asset: { select: { sha256: true, width: true, height: true } } },
          },
          markScheme: {
            include: {
              strips: {
                orderBy: { ordering: 'asc' },
                include: { asset: { select: { sha256: true, width: true, height: true } } },
              },
            },
          },
          skills: { select: { skill: { select: { slug: true } } } },
        },
      },
    },
  });

  if (!paper) return null;

  return {
    id: paper.id,
    subject: bankSubjectName(paper.subject),
    subjectCode: paper.subject.code,
    board: paper.board,
    year: paper.year,
    session: paper.session,
    paperNumber: paper.paperNumber,
    variant: paper.variant,
    questions: paper.questions
      .map((question) => ({
        id: question.id,
        rootNumber: question.rootNumber,
        totalMarks: question.totalMarks,
        pageStart: question.pageStart,
        pageEnd: question.pageEnd,
        hasText: question.bodyMd.trim().length > 0,
        commandTerms: question.skills.map((link) => link.skill.slug).sort(),
        strips: toStrips(question.strips),
        markScheme:
          question.markScheme && question.markScheme.status === 'published'
            ? {
                id: question.markScheme.id,
                strips: toStrips(question.markScheme.strips),
                // Multiple-choice keys are recovered from the text layer with
                // no rendering at all, so they have a letter and no strips.
                answerLetter: question.markScheme.answerLetter,
              }
            : null,
      }))
      // A question whose strips all failed to resolve has nothing to show.
      .filter((question) => question.strips.length > 0),
  };
}

/** Papers that actually have published questions, newest sitting first. */
export async function listBankPapers(limit = 100) {
  const papers = await prisma.bankPaper.findMany({
    where: { docType: 'qp', questions: { some: { status: 'published' } } },
    orderBy: [{ year: 'desc' }, { paperNumber: 'asc' }, { variant: 'asc' }],
    take: limit,
    select: {
      id: true,
      year: true,
      session: true,
      paperNumber: true,
      variant: true,
      subject: { select: { name: true, code: true, level: true, board: true } },
      _count: { select: { questions: true } },
    },
  });

  return papers.map((paper) => ({
    ...paper,
    subject: { ...paper.subject, name: bankSubjectName(paper.subject) },
  }));
}

// ---------- Browsing the bank ----------

export type BankFilters = {
  subjects: Array<{ id: number; code: string; name: string }>;
  years: number[];
  sessions: string[];
  paperNumbers: number[];
  /**
   * Topics that actually have published questions behind them.
   *
   * Empty for now, and the UI hides the control when it is: topics come from
   * the pipeline's tagging stage, which needs the model pass a crop-only run
   * skips, so `bank_topics` holds no rows at all. Offering a dropdown that
   * filters 68,849 questions down to nothing would be worse than offering
   * nothing. It lights up on its own once tagging has run.
   */
  topics: string[];
};

export type BankQuestionSummary = {
  id: number;
  rootNumber: number;
  totalMarks: number | null;
  hasText: boolean;
  hasMarkScheme: boolean;
  /** First strip only: enough for a list row, without loading the whole crop. */
  thumbnail: BankStrip | null;
  paper: {
    id: number;
    subject: string;
    subjectCode: string;
    year: number;
    session: string;
    paperNumber: number;
    variant: number;
  };
};

/**
 * Only question papers, only published questions.
 *
 * Mark scheme and insert documents are separate `BankPaper` rows of their own,
 * and a student browsing questions should never be offered one directly.
 */
function publishedQuestionPaperWhere(subjectCodes: string[] | null) {
  return {
    docType: 'qp',
    questions: { some: { status: 'published' } },
    ...(subjectCodes ? { subject: { code: { in: toBankSubjectCodes(subjectCodes) } } } : {}),
  };
}

/**
 * Translate course-catalog subject codes into the codes the bank stores.
 *
 * The two disagree for IB. The catalog namespaces its codes -- `ib-biology`,
 * `ib-physics` -- while the extraction pipeline derives the bank's from the
 * directory name and stores the bare slug, `biology`. CAIE agrees on both
 * sides because a syllabus number is a syllabus number.
 *
 * Matching the catalog's codes directly therefore returned nothing at all for
 * an enrolled IB student: their scope filtered to `ib-*`, and no such code
 * exists in bank_subjects. Both forms are accepted, so neither side has to be
 * rewritten and a corpus rebuild cannot quietly undo it.
 */
export function toBankSubjectCodes(catalogCodes: string[]): string[] {
  const codes = new Set<string>();
  for (const code of catalogCodes) {
    codes.add(code);
    if (code.startsWith('ib-')) codes.add(code.slice(3));
  }
  return [...codes];
}

/**
 * The filter options that actually have published questions behind them.
 *
 * `subject` is the one the student has selected in the UI, as distinct from
 * `subjectCodes`, which is their course scope. Topics are the reason it exists:
 * `BankTopic` is keyed `@@unique([subjectId, name])`, so "Mechanics" is a
 * different row for every syllabus that has one, and a flat list of every topic
 * in the corpus is both enormous and mostly irrelevant to whatever subject is
 * on screen. Narrowing to the selected subject is what makes the control
 * usable; with none selected the list still respects the course scope.
 */
export async function listBankFilters(
  subjectCodes: string[] | null,
  subject?: string | null,
): Promise<BankFilters> {
  const where = publishedQuestionPaperWhere(subjectCodes);

  /*
   * The selected subject, as the *id* the browser actually sends.
   *
   * This used to read `{ code: { equals: selected } }`, but the subject select
   * is keyed on `BankSubject.id` (see the `<option value={option.id}>` in
   * BankPractice, and `subjectId: intParam(...)` in the questions branch of the
   * route), so it was comparing a numeric id against a syllabus code and never
   * matching. The visible symptom was the topic control behaving backwards:
   * with no subject chosen it offered every topic in the corpus, and choosing a
   * subject emptied the list, which the `topics.length > 0` guard then rendered
   * as the control disappearing.
   *
   * It is separate from `subjectCodes`, which is the student's course scope:
   * scope says what they may see, this says what they are looking at.
   */
  const selectedSubjectId = Number.parseInt(subject?.trim() || '', 10);
  const subjectId = Number.isFinite(selectedSubjectId) && selectedSubjectId > 0 ? selectedSubjectId : null;

  // Every paper-derived list is scoped to the selected subject too, so the year,
  // session and paper controls offer what that syllabus actually has rather
  // than the union across the whole bank -- an IB subject has no "Paper 41",
  // and a CAIE one has no "May TZ2".
  const paperWhere = subjectId ? { ...where, subjectId } : where;

  const [subjects, years, sessions, paperNumbers, topics] = await Promise.all([
    // Not narrowed by `subjectId`: this is the list the selection is made from.
    prisma.bankSubject.findMany({
      where: { papers: { some: where } },
      orderBy: [{ name: 'asc' }, { level: 'asc' }],
      select: { id: true, code: true, name: true, level: true, board: true },
    }),
    prisma.bankPaper.findMany({
      where: paperWhere, distinct: ['year'], orderBy: { year: 'desc' }, select: { year: true },
    }),
    prisma.bankPaper.findMany({
      where: paperWhere, distinct: ['session'], orderBy: { session: 'asc' }, select: { session: true },
    }),
    prisma.bankPaper.findMany({
      where: paperWhere, distinct: ['paperNumber'], orderBy: { paperNumber: 'asc' },
      select: { paperNumber: true },
    }),
    /*
     * Topics that this subject's questions are actually tagged with.
     *
     * Deliberately NOT `BankTopic.subjectId = subjectId`, which is the obvious
     * reading and is wrong here: the bank files each IB subject as several
     * rows, one per level, and the tagging pass attached every topic to only
     * one of them. Physics HL (subject 60) has 1,610 published questions and
     * 1,590 of them are tagged -- but all 16 of their topics are filed under
     * Physics SL (subject 61), so matching on the topic's own subject returned
     * an empty list and the control disappeared. 38 subject rows covering
     * 10,963 published questions are in that state.
     *
     * Going through the question's paper instead asks the question the student
     * is actually asking -- "which topics can I filter this list by?" -- and is
     * indifferent to where the topic row happens to be filed. With no subject
     * chosen this returns nothing rather than every topic in the bank, because
     * the browser hides the control until one is picked.
     */
    subjectId
      ? prisma.bankTopic.findMany({
          where: {
            questions: { some: { question: { status: 'published', paper: paperWhere } } },
          },
          orderBy: { name: 'asc' },
          select: { name: true },
          distinct: ['name'],
        })
      : Promise.resolve([] as { name: string }[]),
  ]);

  return {
    // The stored name is "CAIE 0625" for CAIE papers; resolve it the same way
    // the paper view does, so the two lists agree.
    subjects: subjects.map((subject) => ({
      id: subject.id,
      code: subject.code,
      name: bankSubjectName(subject),
    })),
    years: years.map((row) => row.year),
    sessions: sessions.map((row) => row.session),
    paperNumbers: paperNumbers.map((row) => row.paperNumber),
    topics: topics.map((row) => row.name),
  };
}

/**
 * A page of questions across papers, for the Practice browser.
 *
 * Loads one strip per question rather than the whole crop: a 20-row page of
 * seven-strip questions would otherwise pull 140 images the list never shows.
 */
export async function listBankQuestions(options: {
  subjectCodes: string[] | null;
  subjectId?: number | null;
  year?: number | null;
  session?: string | null;
  paperNumber?: number | null;
  topic?: string | null;
  /** When set, only questions this user has starred. */
  bookmarkedBy?: string | null;
  page?: number;
  limit?: number;
}): Promise<{ questions: BankQuestionSummary[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));

  const where = {
    status: 'published',
    ...(options.bookmarkedBy
      ? { bookmarks: { some: { userId: options.bookmarkedBy } } }
      : {}),
    ...(options.topic ? { topics: { some: { topic: { name: options.topic } } } } : {}),
    paper: {
      ...publishedQuestionPaperWhere(options.subjectCodes),
      ...(options.subjectId ? { subjectId: options.subjectId } : {}),
      ...(options.year ? { year: options.year } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(options.paperNumber ? { paperNumber: options.paperNumber } : {}),
    },
  };

  const [total, rows] = await Promise.all([
    prisma.bankQuestion.count({ where }),
    prisma.bankQuestion.findMany({
      where,
      orderBy: [{ paperId: 'asc' }, { rootNumber: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        rootNumber: true,
        totalMarks: true,
        bodyMd: true,
        markScheme: { select: { id: true, status: true } },
        strips: {
          orderBy: { ordering: 'asc' },
          take: 1,
          select: { page: true, asset: { select: { sha256: true, width: true, height: true } } },
        },
        paper: {
          select: {
            id: true, year: true, session: true, paperNumber: true, variant: true,
            subject: { select: { name: true, code: true, level: true, board: true } },
          },
        },
      },
    }),
  ]);

  return {
    total,
    page,
    limit,
    questions: rows.map((row) => ({
      id: row.id,
      rootNumber: row.rootNumber,
      totalMarks: row.totalMarks,
      hasText: row.bodyMd.trim().length > 0,
      hasMarkScheme: row.markScheme?.status === 'published',
      thumbnail: toStrips(row.strips)[0] ?? null,
      paper: {
        id: row.paper.id,
        subject: bankSubjectName(row.paper.subject),
        subjectCode: row.paper.subject.code,
        year: row.paper.year,
        session: row.paper.session,
        paperNumber: row.paper.paperNumber,
        variant: row.paper.variant,
      },
    })),
  };
}

/** One question with its whole crop, and its mark scheme if there is one. */
export async function getBankQuestion(
  questionId: number
): Promise<(BankQuestionView & { paper: BankQuestionSummary['paper'] }) | null> {
  const question = await prisma.bankQuestion.findFirst({
    where: { id: questionId, status: 'published' },
    include: {
      strips: {
        orderBy: { ordering: 'asc' },
        include: { asset: { select: { sha256: true, width: true, height: true } } },
      },
      markScheme: {
        include: {
          strips: {
            orderBy: { ordering: 'asc' },
            include: { asset: { select: { sha256: true, width: true, height: true } } },
          },
        },
      },
      skills: { select: { skill: { select: { slug: true } } } },
      paper: {
        select: {
          id: true, year: true, session: true, paperNumber: true, variant: true,
          subject: { select: { name: true, code: true, level: true, board: true } },
        },
      },
    },
  });

  if (!question) return null;

  return {
    id: question.id,
    rootNumber: question.rootNumber,
    totalMarks: question.totalMarks,
    pageStart: question.pageStart,
    pageEnd: question.pageEnd,
    hasText: question.bodyMd.trim().length > 0,
    // Sorted so the same question always presents its terms in the same order,
    // whatever order the join comes back in.
    commandTerms: question.skills.map((link) => link.skill.slug).sort(),
    strips: toStrips(question.strips),
    markScheme:
      question.markScheme && question.markScheme.status === 'published'
        ? {
            id: question.markScheme.id,
            strips: toStrips(question.markScheme.strips),
            answerLetter: question.markScheme.answerLetter,
          }
        : null,
    paper: {
      id: question.paper.id,
      subject: bankSubjectName(question.paper.subject),
      subjectCode: question.paper.subject.code,
      year: question.paper.year,
      session: question.paper.session,
      paperNumber: question.paper.paperNumber,
      variant: question.paper.variant,
    },
  };
}
