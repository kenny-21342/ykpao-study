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
