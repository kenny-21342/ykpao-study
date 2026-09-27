import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { toBankSubjectCodes } from '@/lib/bank-questions';
import { chooseTemplate, loadPaperTemplates } from '@/lib/paper-templates';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mock-exams/formats?subjectCode=0625&level=IGCSE
 *
 * The paper formats this subject can actually be generated in, measured from
 * the real papers in the corpus rather than listed by hand.
 *
 * The form needs this because a mark total is the wrong question to ask a
 * student: "80 marks of Physics" describes no paper anyone sits, while
 * "Paper 4 — 9 questions, 70 marks" describes one they have seen. Offering
 * only formats that were measured also means the form can never suggest a
 * shape that generation would then fail to fill.
 *
 * Signed in only, and nothing here is user-specific, so it caches privately
 * for a few minutes: the templates themselves change when an extraction pass
 * lands, which is days apart.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const subjectCode = searchParams.get('subjectCode')?.trim();
  const level = searchParams.get('level')?.trim() || null;
  if (!subjectCode) return NextResponse.json({ error: 'subjectCode is required' }, { status: 400 });

  const bankCode = toBankSubjectCodes([subjectCode])[0] ?? subjectCode;
  const templates = await loadPaperTemplates(bankCode);
  const preferred = chooseTemplate(templates, { level });

  // Filtered to the learner's level where one is given, because an IB student
  // should not be offered the HL paper list beside the SL one with no way to
  // tell which is which. Falls back to everything when nothing matches, the
  // same rule `chooseTemplate` uses, so a level we cannot parse never empties
  // the list.
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = level ? norm(level) : null;
  const atLevel = wanted ? templates.filter((t) => norm(t.level) === wanted) : templates;
  const shown = atLevel.length > 0 ? atLevel : templates;

  return NextResponse.json(
    {
      formats: shown.map((t) => ({
        paperNumber: t.paperNumber,
        level: t.level,
        questionCount: t.questionCount,
        totalMarks: t.totalMarks,
        style: t.style,
        papersObserved: t.papersObserved,
        // The board's own name and duration where we have them. "Paper 4 --
        // Theory (Extended), 1h15, 80 marks" is a paper a student recognises;
        // "Paper 4 -- 9 questions, 70 marks" is one nobody has ever sat.
        name: t.official?.name ?? null,
        minutes: t.official?.minutes ?? null,
        marksAreOfficial: t.official != null,
        officialSource: t.official?.source ?? null,
        recommended: preferred?.paperNumber === t.paperNumber && preferred?.level === t.level,
      })),
    },
    { headers: { 'Cache-Control': 'private, max-age=300' } },
  );
}
