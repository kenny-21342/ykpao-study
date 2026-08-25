"""Tests for the crop checks — the QA that guards a crop-first bank.

These run on geometry, not on a transcription, because in crop-first mode the
image is what a student reads and there may be no transcription at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fitz

from pdf_extraction.bank.qa import (
    ISSUE_CROP_EMPTY,
    ISSUE_CROP_FURNITURE,
    ISSUE_CROP_MISSING_NUMBER,
    ISSUE_CROP_NO_MARKS,
    run_crop_checks,
)
from pdf_extraction.bank.spans import PageRegion, RootSpan


@dataclass(frozen=True)
class FakeStrip:
    page: int
    bbox: tuple[float, float, float, float]


@dataclass(frozen=True)
class FakeRendered:
    root_number: int
    strips: tuple[FakeStrip, ...]


def _question_page(path: Path) -> None:
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((50, 80), "1 State the name of the process.", fontsize=11)
    page.insert_text((500, 140), "[3]", fontsize=11)
    page.insert_text((50, 800), "(c) UCLES 2023      Page 2 of 12", fontsize=9)
    document.save(path)
    document.close()


def _mark_scheme_page(path: Path) -> None:
    """A landscape grid whose rightmost column is Marks."""
    document = fitz.open()
    page = document.new_page(width=842, height=595)
    columns = (60.0, 200.0, 620.0, 780.0)
    top, height = 60.0, 40.0
    for index in range(3):
        page.draw_line((columns[0], top + height * index), (columns[-1], top + height * index))
    page.insert_text((columns[0] + 4, top + 22), "Question", fontsize=11)
    page.insert_text((columns[1] + 4, top + 22), "Answer", fontsize=11)
    page.insert_text((columns[2] + 4, top + 22), "Marks", fontsize=11)
    page.insert_text((columns[0] + 4, top + height + 22), "1", fontsize=11)
    page.insert_text((columns[1] + 4, top + height + 22), "the expected answer", fontsize=11)
    page.insert_text((columns[2] + 4, top + height + 22), "2", fontsize=11)
    for x in columns:
        page.draw_line((x, top), (x, top + height * 2))
    document.save(path)
    document.close()


class CropCheckTests(unittest.TestCase):
    def test_a_clean_question_crop_raises_nothing(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _question_page(path)
            span = RootSpan(root_number=1, regions=(
                PageRegion(page=1, bbox=(40.0, 60.0, 560.0, 160.0)),
            ))
            rendered = FakeRendered(1, (FakeStrip(1, (40.0, 60.0, 560.0, 160.0)),))
            self.assertEqual(run_crop_checks(path, span, rendered, "qp", 1), [])

    def test_a_crop_starting_below_the_question_number_is_flagged(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _question_page(path)
            # Starts below the "1 State..." line, so the number is missing.
            span = RootSpan(root_number=1, regions=(
                PageRegion(page=1, bbox=(40.0, 100.0, 560.0, 160.0)),
            ))
            rendered = FakeRendered(1, (FakeStrip(1, (40.0, 100.0, 560.0, 160.0)),))
            issues = {flag.issue_type for flag in run_crop_checks(path, span, rendered, "qp", 1)}
            self.assertIn(ISSUE_CROP_MISSING_NUMBER, issues)

    def test_page_furniture_inside_a_crop_is_flagged(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _question_page(path)
            span = RootSpan(root_number=1, regions=(
                PageRegion(page=1, bbox=(40.0, 60.0, 560.0, 820.0)),
            ))
            rendered = FakeRendered(1, (FakeStrip(1, (40.0, 60.0, 560.0, 820.0)),))
            issues = {flag.issue_type for flag in run_crop_checks(path, span, rendered, "qp", 1)}
            self.assertIn(ISSUE_CROP_FURNITURE, issues)

    def test_a_span_that_rendered_nothing_is_flagged(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _question_page(path)
            span = RootSpan(root_number=1, regions=())
            flags = run_crop_checks(path, span, FakeRendered(1, ()), "qp", 1)
            self.assertEqual([flag.issue_type for flag in flags], [ISSUE_CROP_EMPTY])

    def test_a_mark_scheme_crop_missing_the_marks_column_is_flagged(self) -> None:
        """The check that would have caught the rotation bug.

        That bug trimmed every rotated mark-scheme strip to the unrotated page
        width, which cut off the Marks column — the entire content of a mark
        scheme — on 43 of 80 sampled papers.
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "ms.pdf"
            _mark_scheme_page(path)
            span = RootSpan(root_number=1, regions=(
                PageRegion(page=1, bbox=(0.0, 60.0, 842.0, 140.0)),
            ))

            full = FakeRendered(1, (FakeStrip(1, (0.0, 60.0, 842.0, 140.0)),))
            self.assertNotIn(
                ISSUE_CROP_NO_MARKS,
                {flag.issue_type for flag in run_crop_checks(path, span, full, "ms", 1)},
            )

            # Stops before the Marks column, the shape the bug produced.
            clipped = FakeRendered(1, (FakeStrip(1, (0.0, 60.0, 610.0, 140.0)),))
            issues = {flag.issue_type for flag in run_crop_checks(path, span, clipped, "ms", 1)}
            self.assertIn(ISSUE_CROP_NO_MARKS, issues)



class PaperWideMarksTests(unittest.TestCase):
    """A whole paper without marks is a multiple-choice paper, not 40 faults.

    Multiple-choice papers print no per-question mark allocation. Flagging
    each question individually put 75% of paper 1 and 45% of paper 2 into
    review across the corpus, against 1-3% of the structured papers, and
    pushed three quarters of the bank out of the merge.
    """

    @staticmethod
    def _flag(root: int):
        from pdf_extraction.bank.qa import SEVERITY_MEDIUM, ReviewFlag

        return ReviewFlag(
            question_id=None, paper_id=1, issue_type=ISSUE_CROP_NO_MARKS,
            severity=SEVERITY_MEDIUM, message="", evidence={"root_number": root},
        )

    def test_a_paper_where_almost_nothing_shows_marks_keeps_none_of_the_flags(self):
        from pdf_extraction.bank.run import _drop_paper_wide_marks_flag

        flags = {root: [self._flag(root)] for root in range(1, 41)}
        _drop_paper_wide_marks_flag(flags)
        self.assertEqual(sum(len(value) for value in flags.values()), 0)

    def test_a_structured_paper_keeps_its_flags(self):
        """One question missing its marks is a crop that stopped short."""
        from pdf_extraction.bank.run import _drop_paper_wide_marks_flag

        flags = {root: [] for root in range(1, 11)}
        flags[4] = [self._flag(4)]
        _drop_paper_wide_marks_flag(flags)
        self.assertEqual(len(flags[4]), 1)

    def test_other_flags_on_a_multiple_choice_paper_survive(self):
        """Only the marks flag is paper-wide; the rest still apply."""
        from pdf_extraction.bank.qa import SEVERITY_HIGH, ReviewFlag
        from pdf_extraction.bank.run import _drop_paper_wide_marks_flag

        flags = {root: [self._flag(root)] for root in range(1, 41)}
        erased = ReviewFlag(question_id=None, paper_id=1,
                            issue_type="crop_erased_text", severity=SEVERITY_HIGH,
                            message="", evidence={})
        flags[7].append(erased)
        _drop_paper_wide_marks_flag(flags)
        self.assertEqual(flags[7], [erased])


if __name__ == "__main__":
    unittest.main()
