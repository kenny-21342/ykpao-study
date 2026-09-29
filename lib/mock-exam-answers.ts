/**
 * Did the student actually answer this item?
 *
 * Deceptively easy to get wrong, and both obvious fields are traps:
 *
 * `attemptedAt` is stamped on *every* item at submission, answered or not, so
 * the paper can be resumed and reviewed. A paper with one answer reported ten
 * attempted.
 *
 * `answerLetter` is the mark scheme's **key**, not the student's choice. The
 * server withholds it until the paper is submitted (it sends `options` during
 * the exam so the buttons can be drawn without handing over the answer), and
 * `gradeAgainstKey(answer, answerLetter)` is what compares the two. After
 * submission every multiple-choice item has one, so counting it said 25 of 26
 * attempted on a paper with a single answer.
 *
 * The student's own response -- typed prose or the letter they picked -- is
 * always `answer`, and only `answer`.
 *
 * A scratchpad drawing is deliberately not an answer here. The exam UI agrees:
 * it reports "answered 0 of 26" for a paper with only a drawing, and the
 * drawing rides along with whatever is typed as `answerImageUrl`.
 */
export function hasStudentAnswer(item: { answer: string | null }): boolean {
  return (item.answer ?? '').trim().length > 0;
}
