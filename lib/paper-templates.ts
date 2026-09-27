/**
 * What a real paper of a given subject actually looks like.
 *
 * Mock exams used to be packed to a mark total: draw questions at random from
 * the subject until the marks add up. That produces a paper with the right
 * weight and the wrong shape -- twenty one-mark questions where the real Paper
 * 4 is nine questions of eight marks, or a multiple-choice question sitting in
 * the middle of a structured paper. `lib/feature-readiness.ts` carried a
 * banner admitting exactly that, and the banner was removed before the gap
 * was, so this closes it.
 *
 * **The shape is measured, not written down.** There are 183 (syllabus, level,
 * paper number) groups in the corpus and nobody is going to hand-author a
 * blueprint for each, keep 49 syllabuses' worth up to date, or get IB and
 * Cambridge conventions right from memory. Every template here is a median
 * over the real papers already in `bank_papers`, so a subject is supported the
 * moment its papers are extracted, and the templates correct themselves as
 * extraction improves.
 *
 * Medians rather than means throughout, because the inputs have a known tail:
 * a paper whose extraction cut short contributes a short question list, and a
 * mean would quietly drag every template toward it. A median ignores it.
 *
 * Measured against production on 27 Sep 2026: 175 of the 183 groups have three
 * or more papers to average, every one of those holds at least three times the
 * questions a paper of its own shape needs, and exactly one (IB Economics HL
 * Paper 3) has mark data on fewer than half its questions.
 */
import { Prisma } from '@prisma/client';
import { applyOfficialFormat, type OfficialPaperTemplate } from '@/lib/paper-format-overlay';
import { officialFormat } from '@/lib/paper-formats';
import {
  derivePaperTemplates,
  MIN_PAPERS,
  type TemplateRow,
} from '@/lib/paper-template-shape';

export {
  derivePaperTemplates,
  chooseTemplate,
  MIN_PAPERS,
  type PaperSlot,
  type PaperTemplate,
  type TemplateRow,
} from '@/lib/paper-template-shape';
export { applyOfficialFormat, type OfficialPaperTemplate } from '@/lib/paper-format-overlay';
import { prisma } from '@/lib/prisma';

/**
 * Measure one subject's papers.
 *
 * One aggregate query rather than pulling every question back to be counted in
 * JavaScript: a large syllabus holds seven thousand published questions, and
 * this runs behind a form a student is waiting on.
 */
export async function measureSubject(subjectCode: string): Promise<TemplateRow[]> {
  return prisma.$queryRaw<TemplateRow[]>(Prisma.sql`
    WITH q AS (
      SELECT s.level, p."paperNumber" AS pn, p.id AS paper_id,
             q."rootNumber" AS position,
             COALESCE(m."totalMarks", q."totalMarks") AS marks,
             (m."answerLetter" IS NOT NULL) AS keyed
      FROM bank_questions q
      JOIN bank_papers p ON p.id = q."paperId"
      JOIN bank_subjects s ON s.id = p."subjectId"
      LEFT JOIN bank_mark_schemes m ON m."questionId" = q.id
      WHERE q.status = 'published' AND p."docType" = 'qp' AND s.code = ${subjectCode}
    ),
    per_paper AS (
      SELECT level, pn, paper_id, COUNT(*)::int AS qs FROM q GROUP BY 1, 2, 3
    ),
    shape AS (
      SELECT level, pn,
             COUNT(*)::int AS papers_observed,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY qs)::int AS median_questions
      FROM per_paper GROUP BY 1, 2
    ),
    group_marks AS (
      SELECT level, pn,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY marks)::int AS group_median_marks,
             AVG(CASE WHEN keyed THEN 1.0 ELSE 0.0 END)::float AS keyed_fraction
      FROM q GROUP BY 1, 2
    ),
    slots AS (
      SELECT level, pn, position,
             COUNT(DISTINCT paper_id)::int AS position_seen,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY marks)
               FILTER (WHERE marks IS NOT NULL)::int AS median_marks
      FROM q GROUP BY 1, 2, 3
    )
    SELECT sl.level AS "level",
           sl.pn AS "paperNumber",
           sl.position AS "position",
           sh.papers_observed AS "papersObserved",
           sl.position_seen AS "positionSeen",
           sh.median_questions AS "medianQuestions",
           sl.median_marks AS "medianMarks",
           gm.group_median_marks AS "groupMedianMarks",
           gm.keyed_fraction AS "keyedFraction"
    FROM slots sl
    JOIN shape sh ON sh.level = sl.level AND sh.pn = sl.pn
    JOIN group_marks gm ON gm.level = sl.level AND gm.pn = sl.pn
    WHERE sh.papers_observed >= ${MIN_PAPERS}
    ORDER BY sl.level, sl.pn, sl.position
  `);
}

/**
 * Templates for a subject, cached per instance.
 *
 * The corpus changes when an extraction pass lands, which is days apart, so an
 * hour is generous and still bounded. Concurrent misses share one query, the
 * same reason `/api/platform-stats` does it.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; templates: OfficialPaperTemplate[] }>();
const inFlight = new Map<string, Promise<OfficialPaperTemplate[]>>();

export async function loadPaperTemplates(subjectCode: string): Promise<OfficialPaperTemplate[]> {
  const hit = cache.get(subjectCode);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.templates;

  const existing = inFlight.get(subjectCode);
  if (existing) return existing;

  const pending = (async () => {
    try {
      // The board's figures are applied here rather than at each call site, so
      // nothing downstream can accidentally use the uncorrected total -- which
      // for IGCSE History Paper 4 is 520 marks against an official 40.
      const templates = derivePaperTemplates(subjectCode, await measureSubject(subjectCode))
        .map((template) => applyOfficialFormat(
          template,
          officialFormat(subjectCode, template.level, template.paperNumber),
        ))
        // A shape that cannot carry its official total is dropped rather than
        // offered: the caller then packs to a mark total, which is what every
        // subject did before templates existed.
        .filter((template) => template.shapeCredible);
      cache.set(subjectCode, { at: Date.now(), templates });
      return templates;
    } catch (error) {
      console.error('[paper-templates] could not measure %s:', subjectCode, error);
      // No template means the caller packs to a mark total instead, which is
      // the behaviour that shipped for a year. A measurement failure must
      // degrade to that, never fail the generation.
      return cache.get(subjectCode)?.templates ?? [];
    } finally {
      inFlight.delete(subjectCode);
    }
  })();
  inFlight.set(subjectCode, pending);
  return pending;
}

/** Clears the memo. Tests only. */
export function resetPaperTemplateCache(): void {
  cache.clear();
  inFlight.clear();
}

