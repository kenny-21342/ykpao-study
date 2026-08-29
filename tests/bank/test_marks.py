"""Guards on deterministically extracted mark totals.

The extraction itself is a bracket regex over a PDF clip and is exercised by
running the CLI; what needs holding still is the decision about when a paper's
numbers are safe to store, because storing a wrong one is invisible -- it
becomes a question weighted wrongly inside a generated exam.
"""

import unittest

from pdf_extraction.bank.marks import (
    COHORT_AGREEMENT,
    MAX_QUESTION_MARKS,
    is_plausible,
    trusted_totals,
)


class IsPlausibleTests(unittest.TestCase):
    def test_a_normal_structured_paper_is_accepted(self):
        # 0606 Paper 1: eleven questions, eighty marks.
        self.assertTrue(is_plausible({1: 4, 2: 3, 3: 3, 4: 7, 5: 9, 6: 8,
                                      7: 8, 8: 9, 9: 10, 10: 11, 11: 8}))

    def test_a_multiple_choice_paper_is_rejected_whole(self):
        # Forty questions, no printed allocation. These already carry
        # total_marks = 1 from the answer-key pass; writing zero over that
        # would make every one of them ineligible for a mock exam.
        self.assertFalse(is_plausible({n: 0 for n in range(1, 41)}))

    def test_one_unparsed_question_rejects_the_whole_paper(self):
        # Half a paper of totals is worse than none: selection would silently
        # prefer whichever questions happened to parse.
        self.assertFalse(is_plausible({1: 6, 2: 0, 3: 8}))

    def test_an_implausibly_large_question_is_rejected(self):
        # A choice paper counts brackets for questions nobody answers, and a
        # span that swallowed its neighbour sums two questions into one.
        self.assertFalse(is_plausible({1: 26, 2: 30, 3: 41}))
        self.assertFalse(is_plausible({1: MAX_QUESTION_MARKS + 1}))

    def test_the_bound_itself_is_allowed(self):
        self.assertTrue(is_plausible({1: MAX_QUESTION_MARKS}))

    def test_an_empty_paper_is_not_a_parsed_paper(self):
        self.assertFalse(is_plausible({}))


class TrustedTotalsTests(unittest.TestCase):
    """A paper's own numbers cannot validate themselves; its cohort can."""

    def test_a_unanimous_cohort_is_written(self):
        # Additional Mathematics paper 1 reads exactly 80 on all 140 papers.
        cohort = {("0606", 1): [(i, 80) for i in range(1, 21)]}
        self.assertEqual(trusted_totals(cohort), set(range(1, 21)))

    def test_a_choice_paper_is_held_back_entirely(self):
        # Economics paper 2 spread across 110, 130, 188 and 190 against a real
        # 90, because the printed brackets include questions nobody answers.
        cohort = {("0455", 2): [(1, 110), (2, 130), (3, 188), (4, 190)]}
        self.assertEqual(trusted_totals(cohort), set())

    def test_a_near_unanimous_cohort_writes_only_the_agreeing_papers(self):
        # 0620 paper 3 reads 80 on 73 papers and 79 on one. The odd paper is
        # held back on its own; the other 73 are not punished for it.
        entries = [(i, 80) for i in range(1, 74)] + [(999, 79)]
        trusted = trusted_totals({("0620", 3): entries})
        self.assertIn(1, trusted)
        self.assertNotIn(999, trusted)
        self.assertEqual(len(trusted), 73)

    def test_the_threshold_is_enforced_not_merely_a_majority(self):
        # Six of ten agreeing is a majority and still not good enough: a real
        # published total does not disagree with itself 40% of the time.
        entries = [(i, 90) for i in range(1, 7)] + [(i, 100) for i in range(7, 11)]
        self.assertEqual(trusted_totals({("x", 1): entries}), set())
        self.assertGreater(COHORT_AGREEMENT, 0.6)

    def test_cohorts_are_judged_independently(self):
        # A subject with one bad paper number keeps its good ones.
        cohort = {
            ("0625", 2): [(1, 80), (2, 80), (3, 80)],
            ("0625", 9): [(4, 12), (5, 400), (6, 55)],
        }
        self.assertEqual(trusted_totals(cohort), {1, 2, 3})

    def test_an_empty_cohort_map_writes_nothing(self):
        self.assertEqual(trusted_totals({}), set())


if __name__ == "__main__":
    unittest.main()
