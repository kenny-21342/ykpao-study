"""Run with: python3 -m unittest pdf_extraction.bank.test_ms_roots"""
import unittest
from dataclasses import dataclass

from .spans import _legacy_numbered_roots, select_numbered_ms_roots


@dataclass
class C:
    number: int
    text: str
    page: int
    y: float
    x: float = 43.0

    @property
    def position(self):
        return (self.page, self.y)

    @property
    def bbox(self):
        return (self.x, self.y, self.x + 10, self.y + 10)


def notes_then_answers():
    """IB Math AA paper 1 shape: generic notes carry '1.' '2.' '10.', answers follow."""
    c = [C(1, "1.", 3, 684), C(2, "2.", 3, 724), C(10, "10.", 7, 177),
         C(1, "1.", 8, 110), C(2, "2", 8, 537)]
    c += [C(n, f"{n}.", 8 + n, 85) for n in range(3, 13)]
    return c


class Selection(unittest.TestCase):
    def test_old_greedy_choice_loses_the_real_questions(self):
        legacy = [c.number for c in _legacy_numbered_roots(notes_then_answers())]
        self.assertEqual(legacy, [1, 2, 10, 11, 12])

    def test_run_aware_choice_takes_the_answers_not_the_notes(self):
        chosen = select_numbered_ms_roots(notes_then_answers(), frozenset(range(1, 13)))
        self.assertEqual([c.number for c in chosen], list(range(1, 13)))
        self.assertTrue(all(c.page >= 8 for c in chosen))

    def test_a_bare_number_fills_a_skipped_heading_only_if_expected(self):
        chosen = select_numbered_ms_roots(notes_then_answers(), frozenset(range(1, 13)))
        self.assertIn(2, [c.number for c in chosen])
        without = select_numbered_ms_roots(notes_then_answers(), frozenset(range(3, 13)))
        self.assertNotIn(2, [c.number for c in without])

    def test_no_headings_returns_nothing(self):
        self.assertEqual(select_numbered_ms_roots([C(3, "3", 5, 10)], None), [])


if __name__ == "__main__":
    unittest.main()


class NotesPages(unittest.TestCase):
    """The "Subject Details" marking-instructions page is dropped before roots are chosen."""

    @staticmethod
    def _evidence(pages):
        from types import SimpleNamespace as NS
        return NS(pages=[NS(number=number, lines=[NS(text=t, bbox=(40, y, 500, y + 10)) for t, y in lines])
                         for number, lines in pages])

    def test_titled_notes_page_is_dropped_whole(self):
        from .spans import ms_notes_cutoffs
        evidence = self._evidence([
            (3, [("Subject Details: Chemistry HL Paper 2 Markscheme", 60),
                 ("1.  Each row in the “Question” column relates to the smallest subpart of the question.", 90),
                 ("9.  Words that are underlined are essential for the mark.", 300)]),
            (4, [("Question    Answers    Notes    Total", 50), ("1.  (a)  CaCO3 + 2HCl", 70)]),
        ])
        self.assertEqual(ms_notes_cutoffs(evidence), {3: float("inf")})

    def test_notes_ending_mid_page_keep_the_answers_below_the_table_header(self):
        from .spans import ms_notes_cutoffs
        evidence = self._evidence([
            (3, [("16. Words inside chevrons « » in the “Answers” column are not necessary to gain the mark.", 80),
                 ("17. Ignore missing state symbols. An alternative word is indicated in the “Answers” column.", 120),
                 ("Question    Answers    Notes    Total", 400),
                 ("1.  (a)  CaCO3 + 2HCl", 430)]),
        ])
        self.assertEqual(ms_notes_cutoffs(evidence), {3: 400})

    def test_one_stock_phrase_in_a_real_answer_is_not_a_notes_page(self):
        from .spans import ms_notes_cutoffs
        evidence = self._evidence([(5, [("3. (b) Accept answers using error carried forward (ECF).", 100)])])
        self.assertEqual(ms_notes_cutoffs(evidence), {})
