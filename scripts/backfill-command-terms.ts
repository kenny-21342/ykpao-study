/**
 * Tag every published bank question with the command terms it uses.
 *
 * Usage:
 *   npx tsx scripts/backfill-command-terms.ts               # dry run, report only
 *   npx tsx scripts/backfill-command-terms.ts --subject 9709
 *   npx tsx scripts/backfill-command-terms.ts --apply
 *
 * `pdf_extraction/bank/tag.py` has computed these since stage 4 was written and
 * thrown them away every time: `store.py::update_question_tagging` wrote
 * difficulty, tags and topics, and there was no column for skills. The
 * extraction is pure text matching (`extract_command_words`), so this backfill
 * costs nothing -- no model call, no re-transcription -- and reruns are free.
 *
 * It reads through `lib/command-terms.ts`, the same module the app renders
 * from, so the drilling UI and the stored tags cannot disagree.
 *
 * Read the dry-run distribution before applying. The plan flags the real risk:
 * COMMAND_WORDS leans Maths/Science, so a subject where nearly every question
 * comes back "state" -- or one where most questions come back with nothing --
 * means the extraction does not fit that subject's phrasing, not that its
 * students are being asked to recall. Fix the vocabulary, not the data.
 *
 * Writes are additive per question: existing links for a term are left alone
 * (ON CONFLICT DO NOTHING semantics via skipDuplicates), and no link is ever
 * deleted here -- the pipeline's `_link_skills` owns replacement.
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { COMMAND_TERMS, extractCommandTerms } from '../lib/command-terms';

const BATCH = 2000;

/**
 * Fail with a sentence rather than a Prisma stack trace when the corpus is not
 * in the database this process is pointed at.
 *
 * There are two Neon projects behind this repo and they are not a dev/prod pair
 * of one schema: `ykpao-study-production` holds the question bank, and the
 * older `smart-edu` project has no `bank_*` tables at all. Running against the
 * wrong one throws P2021 from thirty frames down, which reads like the script
 * is broken. It is the connection that is wrong, and only the connection.
 */
async function requireBankTables() {
  const [{ present }] = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('public.bank_questions') IS NOT NULL AS present
  `;
  if (present) return;

  const host = process.env.DATABASE_URL
    ? new URL(process.env.DATABASE_URL).hostname
    : '(DATABASE_URL not set)';

  console.error(
    `No bank_questions table in the database at ${host}.\n\n` +
      'That is the older `smart-edu` Neon project, which has never held the\n' +
      'question bank. Point DATABASE_URL and DIRECT_DATABASE_URL in .env at the\n' +
      '`ykpao-study-production` project (us-east-2) and run this again.',
  );
  process.exit(1);
}

type Args = { apply: boolean; subject: string | null; limit: number | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, subject: null, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--subject') args.subject = argv[++i] ?? null;
    else if (arg === '--limit') args.limit = Number(argv[++i]) || null;
  }
  return args;
}

/** Every term row, created once up front so the hot loop is pure lookup. */
async function ensureSkillRows(): Promise<Map<string, number>> {
  await prisma.bankSkill.createMany({
    data: COMMAND_TERMS.map((term) => ({ slug: term.slug, label: term.label })),
    skipDuplicates: true,
  });
  const rows = await prisma.bankSkill.findMany({ select: { id: true, slug: true } });
  return new Map(rows.map((row) => [row.slug, row.id]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await requireBankTables();

  const where = {
    status: 'published',
    ...(args.subject ? { paper: { subject: { code: args.subject } } } : {}),
  };

  const total = await prisma.bankQuestion.count({ where });
  console.log(
    `${total} published question(s)${args.subject ? ` in ${args.subject}` : ''}` +
      `${args.apply ? '' : ' -- dry run, nothing will be written'}`,
  );
  if (!total) return;

  const skillIds = args.apply ? await ensureSkillRows() : new Map<string, number>();

  // subject code -> term slug -> question count, and the no-term tally.
  const perSubject = new Map<string, Map<string, number>>();
  const untagged = new Map<string, number>();
  const seen = new Map<string, number>();

  let processed = 0;
  let links = 0;
  let cursor: number | null = null;

  type Row = {
    id: number;
    bodyMd: string;
    paper: { subject: { code: string; name: string } };
  };

  for (;;) {
    const take = args.limit ? Math.min(BATCH, args.limit - processed) : BATCH;
    if (take <= 0) break;

    const questions: Row[] = await prisma.bankQuestion.findMany({
      where,
      select: {
        id: true,
        bodyMd: true,
        paper: { select: { subject: { select: { code: true, name: true } } } },
      },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!questions.length) break;

    const pending: { questionId: number; skillId: number; confidence: number }[] = [];

    for (const question of questions) {
      const code = question.paper.subject.code;
      const terms = extractCommandTerms(question.bodyMd || '');

      seen.set(code, (seen.get(code) ?? 0) + 1);
      if (!terms.length) {
        untagged.set(code, (untagged.get(code) ?? 0) + 1);
        continue;
      }

      let bySlug = perSubject.get(code);
      if (!bySlug) {
        bySlug = new Map();
        perSubject.set(code, bySlug);
      }
      for (const slug of terms) {
        bySlug.set(slug, (bySlug.get(slug) ?? 0) + 1);
        const skillId = skillIds.get(slug);
        // Confidence 1: the term is literally present in the text. This is not
        // a model's guess, and the column should say so.
        if (skillId) pending.push({ questionId: question.id, skillId, confidence: 1 });
      }
    }

    if (args.apply && pending.length) {
      const written = await prisma.bankQuestionSkill.createMany({
        data: pending,
        skipDuplicates: true,
      });
      links += written.count;
    } else {
      links += pending.length;
    }

    processed += questions.length;
    cursor = questions[questions.length - 1].id;
    process.stdout.write(`\r  ${processed}/${args.limit ?? total} questions`);
  }

  process.stdout.write('\n\n');

  const codes = [...seen.keys()].sort();
  for (const code of codes) {
    const counted = seen.get(code) ?? 0;
    const blank = untagged.get(code) ?? 0;
    const bySlug = [...(perSubject.get(code)?.entries() ?? [])].sort((a, b) => b[1] - a[1]);
    const share = (n: number) => `${((n / counted) * 100).toFixed(0)}%`;

    console.log(`${code}  (${counted} questions, ${blank} with no command term -- ${share(blank)})`);
    for (const [slug, count] of bySlug.slice(0, 8)) {
      console.log(`    ${slug.padEnd(12)} ${String(count).padStart(6)}  ${share(count)}`);
    }
    if (bySlug.length > 8) console.log(`    ... and ${bySlug.length - 8} more terms`);
    // The two shapes that mean the vocabulary is wrong for this subject.
    if (counted >= 50 && blank / counted > 0.5) {
      console.log('    ⚠ over half carry no term -- COMMAND_WORDS likely misses this subject\'s phrasing');
    }
    if (bySlug.length && bySlug[0][1] / counted > 0.9 && counted >= 50) {
      console.log(`    ⚠ "${bySlug[0][0]}" on over 90% of questions -- check the extraction, not the students`);
    }
    console.log('');
  }

  console.log(
    args.apply
      ? `✓ wrote ${links} question-skill link(s)`
      : `would write ${links} question-skill link(s) -- rerun with --apply`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
