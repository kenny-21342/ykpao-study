/**
 * Re-mark multiple-choice answers in mock exams submitted before af6c8eb.
 *
 * Usage:
 *   npx tsx scripts/regrade-mock-exam-choices.ts            # report only
 *   npx tsx scripts/regrade-mock-exam-choices.ts --apply
 *
 * The mock-exam answer box was a rich-text editor, so picking option B stored
 * "<p>B</p>". `normalizeOptionLetter` reads a *leading* option letter, found
 * "<", and returned null -- and an unrecognisable answer to a keyed question is
 * graded wrong by design, not left unmarked. Every multiple-choice answer in
 * every submitted paper was therefore marked wrong however right it was: a
 * seven-question Biology paper with five correct choices came back 0/20,
 * grade E.
 *
 * Fixing the marker does nothing for what is already stored, and the damage is
 * wider than the score on the item:
 *
 *   - `MockExamItem.score` / `isCorrect` / `explanation` are wrong.
 *   - `MockExam.score` is a stored total, so it has to be recomputed.
 *   - a matching `BankQuestionAttempt` was written, which the dashboard tiles
 *     and the accuracy figures read.
 *   - a spaced-review card was raised for a question the student got *right*,
 *     which is the one place an error compounds over time.
 *
 * This re-marks through the same `gradeAgainstKey` the app uses, so the script
 * and the app cannot drift apart.
 *
 * Two deliberate limits on what it will delete:
 *
 *   - a review card is removed only when the user has no remaining wrong
 *     attempt on that question, so a card earned in practice survives.
 *   - a card the student has actually reviewed (`repetitions > 0`) is never
 *     deleted, only reported: it carries SM-2 state that cannot be recovered,
 *     and that is a call for a person to make.
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { EXAM_ITEM_INCLUDE, normalizeExamItem } from '../lib/mock-exam-items';
import { gradeAgainstKey } from '../lib/bank-grading';

/** How far from the exam's submission the matching attempt row may sit. */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

type Change = {
  itemId: string;
  bankQuestionId: number;
  answer: string;
  wasCorrect: boolean | null;
  wasScore: number | null;
  nowCorrect: boolean;
  nowScore: number;
  correctLetter: string;
};

async function main() {
  const apply = process.argv.includes('--apply');

  const exams = await prisma.mockExam.findMany({
    where: { submittedAt: { not: null } },
    include: { items: { orderBy: { order: 'asc' }, include: EXAM_ITEM_INCLUDE } },
    orderBy: { submittedAt: 'asc' },
  });

  console.log(`${exams.length.toLocaleString()} submitted mock exams to check.`);

  let itemsChecked = 0;
  let keyedItems = 0;
  const touchedQuestions = new Map<string, Set<number>>(); // userId -> bankQuestionIds
  let examsChanged = 0;
  let itemsChanged = 0;
  let attemptsFixed = 0;
  let attemptsUnmatched = 0;

  for (const exam of exams) {
    const changes: Change[] = [];
    let newTotal = 0;

    for (const item of exam.items) {
      itemsChecked++;
      const normalized = normalizeExamItem(item);
      if (!normalized) continue;

      // Only a keyed item can have been mismarked this way, and a keyed item is
      // always a bank question -- the answer key lives on `BankMarkScheme`.
      const regrade =
        item.bankQuestionId && item.attemptedAt && item.answer
          ? gradeAgainstKey(item.answer, normalized.answerLetter)
          : null;

      if (!regrade) {
        // Not ours to touch: it keeps whatever it scored.
        newTotal += item.score ?? 0;
        continue;
      }
      keyedItems++;

      const max = normalized.marks || 1;
      const nowScore = regrade.isCorrect ? max : 0;
      newTotal += nowScore;

      if (regrade.isCorrect === item.isCorrect && nowScore === (item.score ?? 0)) continue;

      changes.push({
        itemId: item.id,
        bankQuestionId: item.bankQuestionId!,
        answer: item.answer!,
        wasCorrect: item.isCorrect,
        wasScore: item.score,
        nowCorrect: regrade.isCorrect,
        nowScore,
        correctLetter: regrade.correctLetter,
      });
    }

    if (changes.length === 0) continue;
    examsChanged++;
    itemsChanged += changes.length;

    console.log(
      `\n${exam.title} — ${exam.subjectCode ?? 'unknown subject'}, submitted ${exam.submittedAt?.toISOString().slice(0, 10)}`
    );
    console.log(`  score ${exam.score ?? 0} / ${exam.totalMarks}  ->  ${newTotal} / ${exam.totalMarks}`);
    for (const c of changes) {
      const answer = c.answer.length > 40 ? `${c.answer.slice(0, 37)}…` : c.answer;
      console.log(
        `    q${c.bankQuestionId} ${JSON.stringify(answer)} key ${c.correctLetter}: ` +
          `${c.wasCorrect === null ? 'unmarked' : c.wasCorrect ? 'right' : 'wrong'} ${c.wasScore ?? 0} ` +
          `-> ${c.nowCorrect ? 'right' : 'wrong'} ${c.nowScore}`
      );
    }

    if (apply) {
      await prisma.$transaction([
        ...changes.map((c) =>
          prisma.mockExamItem.update({
            where: { id: c.itemId },
            data: {
              score: c.nowScore,
              isCorrect: c.nowCorrect,
              explanation: c.nowCorrect ? null : `The correct answer is ${c.correctLetter}.`,
            },
          })
        ),
        prisma.mockExam.update({ where: { id: exam.id }, data: { score: newTotal } }),
      ]);
    }

    // The attempt row written alongside the item. There is no foreign key
    // between them, so it is found by user, question and submission time.
    const submittedAt = exam.submittedAt!;
    for (const c of changes) {
      const candidates = await prisma.bankQuestionAttempt.findMany({
        where: {
          userId: exam.userId,
          questionId: c.bankQuestionId,
          answer: c.answer,
          gradedBy: 'key',
          createdAt: {
            gte: new Date(submittedAt.getTime() - ATTEMPT_WINDOW_MS),
            lte: new Date(submittedAt.getTime() + ATTEMPT_WINDOW_MS),
          },
        },
        select: { id: true },
      });

      if (candidates.length !== 1) {
        // Zero means the attempt is gone or out of window; more than one means
        // the same answer was submitted twice and there is no way to tell them
        // apart. Either way, say so rather than guess.
        attemptsUnmatched++;
        console.log(
          `    ! ${candidates.length} attempt rows matched q${c.bankQuestionId}; left alone`
        );
        continue;
      }
      attemptsFixed++;
      if (apply) {
        await prisma.bankQuestionAttempt.update({
          where: { id: candidates[0].id },
          data: { isCorrect: c.nowCorrect, score: c.nowScore },
        });
      }
    }

    for (const c of changes.filter((c) => c.nowCorrect)) {
      const set = touchedQuestions.get(exam.userId) ?? new Set<number>();
      set.add(c.bankQuestionId);
      touchedQuestions.set(exam.userId, set);
    }
  }

  // Review cards raised for answers that were in fact correct.
  let cardsDeleted = 0;
  let cardsKeptStillWrong = 0;
  let cardsKeptReviewed = 0;

  for (const [userId, questionIds] of touchedQuestions) {
    for (const questionId of questionIds) {
      const card = await prisma.reviewItem.findUnique({
        where: { userId_bankQuestionId: { userId, bankQuestionId: questionId } },
        select: { id: true, repetitions: true, lastReviewedAt: true },
      });
      if (!card) continue;

      const stillWrong = await prisma.bankQuestionAttempt.count({
        where: { userId, questionId, isCorrect: false },
      });
      if (stillWrong > 0) {
        cardsKeptStillWrong++;
        continue;
      }
      if (card.repetitions > 0 || card.lastReviewedAt) {
        cardsKeptReviewed++;
        console.log(`  ? review card ${card.id} (q${questionId}) has been reviewed; not deleting`);
        continue;
      }
      cardsDeleted++;
      if (apply) await prisma.reviewItem.delete({ where: { id: card.id } });
    }
  }

  const verb = apply ? '' : ' (dry run — pass --apply)';
  console.log(`\nChecked ${itemsChecked.toLocaleString()} items, ${keyedItems.toLocaleString()} with an answer key.`);
  console.log(`  ${itemsChanged.toLocaleString()} items re-marked across ${examsChanged.toLocaleString()} exams${verb}`);
  console.log(`  ${attemptsFixed.toLocaleString()} attempt rows corrected${verb}`);
  if (attemptsUnmatched) console.log(`  ${attemptsUnmatched.toLocaleString()} attempt rows could not be matched; see above`);
  console.log(`  ${cardsDeleted.toLocaleString()} review cards removed as unearned${verb}`);
  if (cardsKeptStillWrong) console.log(`  ${cardsKeptStillWrong.toLocaleString()} review cards kept: the question was got wrong elsewhere too`);
  if (cardsKeptReviewed) console.log(`  ${cardsKeptReviewed.toLocaleString()} review cards kept: already reviewed, decide by hand`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
