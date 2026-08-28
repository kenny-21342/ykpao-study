/**
 * Repair spaced-review cards whose answer is the old placeholder string.
 *
 * Usage:
 *   npx tsx scripts/repair-placeholder-reviews.ts            # report only
 *   npx tsx scripts/repair-placeholder-reviews.ts --apply
 *
 * `upsertMistakeReview` used to write the literal sentence below into
 * `ReviewItem.answer` whenever it had no model answer and no mark scheme to
 * fall back on. Because it was persisted rather than substituted at render
 * time, fixing the writer does nothing for the cards already in the database --
 * on a real account a third of the due queue carried it, and the first card
 * served was one of them.
 *
 * For each affected card this tries to recover the real mark scheme from the
 * matching `ms` document, exactly as the grading routes do. Where that finds
 * nothing, the card is deleted: a review card with no answer on it cannot be
 * reviewed, and leaving it in the queue is the defect.
 *
 * Deleting loses only the card, never the attempt it came from -- those live in
 * the attempt tables and are untouched here. A future mistake on the same
 * question raises a fresh card.
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { PLACEHOLDER_ANSWER as PLACEHOLDER } from '../lib/learning';

async function main() {
  const apply = process.argv.includes('--apply');

  const stranded = await prisma.reviewItem.findMany({
    where: { answer: PLACEHOLDER },
    select: { id: true, questionId: true, userId: true, subject: true },
  });

  console.log(`${stranded.length.toLocaleString()} review cards carry the placeholder.`);
  if (stranded.length === 0) return;

  let repaired = 0;
  let removed = 0;
  // Why a card could not be repaired, so a zero recovery rate can be read as a
  // fact about the data rather than taken on trust from this script.
  let orphaned = 0;      // the question row is gone (relation is SET NULL)
  let notQp = 0;         // the question is not on a question paper
  let noMarkScheme = 0;  // no matching row in the `ms` document

  for (const card of stranded) {
    // `questionId` is nullable: a card outlives the question it came from,
    // because the relation is ON DELETE SET NULL. Such a card can never be
    // repaired, so it falls through to the delete below.
    const question = card.questionId
      ? await prisma.pastPaperQuestion.findUnique({
          where: { id: card.questionId },
          include: { paper: true },
        })
      : null;

    if (!question) orphaned++;
    else if (question.paper.docType !== 'qp') notQp++;

    let markscheme: string | null = null;
    if (question && question.paper.docType === 'qp') {
      const found = await prisma.pastPaperQuestion.findFirst({
        where: {
          paper: {
            subjectId: question.paper.subjectId,
            year: question.paper.year,
            session: question.paper.session,
            paperNumber: question.paper.paperNumber,
            variant: question.paper.variant,
            docType: 'ms',
          },
          number: question.number,
          part: question.part,
          subPart: question.subPart,
        },
        select: { content: true },
      });
      markscheme = found?.content?.trim() || null;
      if (!markscheme) noMarkScheme++;
    }

    if (markscheme) {
      repaired++;
      if (apply) {
        await prisma.reviewItem.update({
          where: { id: card.id },
          data: { answer: markscheme.slice(0, 5000) },
        });
      }
    } else {
      removed++;
      if (apply) {
        await prisma.reviewItem.delete({ where: { id: card.id } });
      }
    }
  }

  const verb = apply ? '' : ' (dry run — pass --apply)';
  console.log(`  recovered a mark scheme for ${repaired.toLocaleString()}${verb}`);
  console.log(`  deleted as unanswerable ${removed.toLocaleString()}${verb}`);
  console.log('  of those that could not be recovered:');
  console.log(`    ${orphaned.toLocaleString()} have no question row left (relation is ON DELETE SET NULL)`);
  console.log(`    ${notQp.toLocaleString()} point at something other than a question paper`);
  console.log(`    ${noMarkScheme.toLocaleString()} have a question paper but no matching mark-scheme row`);

  // The subjects involved, so a suspicious result is legible without a query.
  const bySubject = new Map<string, number>();
  for (const card of stranded) bySubject.set(card.subject, (bySubject.get(card.subject) ?? 0) + 1);
  console.log('  by subject:');
  for (const [subject, count] of [...bySubject].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${subject}: ${count}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
