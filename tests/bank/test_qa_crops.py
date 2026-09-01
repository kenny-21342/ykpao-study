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
    _crop_words,
    ISSUE_CROP_EMPTY,
    ISSUE_CROP_ERASED_TEXT,
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


def _erasable_page(path: Path, sentence: str) -> None:
    """A question whose stem is one line, plus the usual page furniture."""
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((50, 80), sentence, fontsize=11)
    page.insert_text((500, 140), "[4]", fontsize=11)
    page.insert_text((50, 800), "\u00a9 UCLES 2023", fontsize=9)
    document.save(path)
    document.close()


def _notice_page(path: Path, extra: str = "") -> None:
    """The end of a real question paper: last line, then the copyright block.

    The wording is CAIE's own. Its second paragraph is ordinary English, which
    is why `is_content_token` cannot tell it from question text on its own.
    """
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((50, 80), "12 State one advantage of the method.", fontsize=11)
    page.insert_text((500, 100), "[4]", fontsize=11)
    lines = [
        "Permission to reproduce items where third-party owned material protected by",
        "copyright is included has been sought and cleared where possible.",
        "To avoid the issue of disclosure of answer-related information to candidates,",
        "all copyright acknowledgements are reproduced online in the Cambridge",
        f"International Examinations Copyright Acknowledgements Booklet. {extra}",
    ]
    for index, line in enumerate(lines):
        page.insert_text((50, 700 + index * 14), line, fontsize=8)
    document.save(path)
    document.close()


def _notice_band(path: Path) -> tuple[float, float, float, float]:
    """A band over the whole copyright block, as the renderer paints it."""
    return (40.0, 690.0, 560.0, 780.0)


def _word_box(path: Path, wanted: str) -> tuple[float, float, float, float]:
    """The bbox of a word on page 1, padded the way an erase box would be.

    Computed from the real glyph geometry rather than hardcoded, so the test
    does not depend on the font metrics of whatever build of MuPDF is present.
    """
    with fitz.open(path) as document:
        for x0, y0, x1, y1, word, *_ in document[0].get_text("words"):
            if word == wanted:
                return (x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5)
    raise AssertionError(f"{wanted!r} is not on the page")


class ErasedTextTests(unittest.TestCase):
    """An erase box may remove answer rules and furniture. Never content.

    The bank shipped with a question reading "the line y = ax +" whose constant
    had been painted out by an answer-rule box; the mark scheme showed it should
    be "ax + 9". crop_erased_text did not flag it, because a lost "9" is
    excluded three times over: _CROP_INTENDED_ERASE ends in a catch-all matching
    any one- or two-character token, it separately whitelists \\d{1,3}, and the
    casualty filter then strips non-letters and requires three characters.
    """

    SENTENCE = "1 Find the values of a for which the line y = ax + 9 intersects"

    def _run(self, path: Path, erase: tuple[float, float, float, float]):
        span = RootSpan(root_number=1, regions=(
            PageRegion(page=1, bbox=(40.0, 60.0, 560.0, 160.0), erase_bboxes=(erase,)),
        ))
        rendered = FakeRendered(1, (FakeStrip(1, (40.0, 60.0, 560.0, 160.0)),))
        return {flag.issue_type for flag in run_crop_checks(path, span, rendered, "qp", 1)}

    def _casualties(self, path: Path, erase) -> list[str]:
        """What the detector counts as lost, given boxes that WERE painted.

        Called directly rather than through run_crop_checks, which now filters
        boxes through the render-time guard first. Both layers matter and they
        are tested apart: this one asks whether a loss would be noticed, and
        the tests below ask whether it can happen at all.
        """
        with fitz.open(path) as document:
            _kept, casualties = _crop_words(
                document[0], (40.0, 60.0, 560.0, 160.0), (erase,))
        return casualties

    def test_a_lost_digit_is_counted(self) -> None:
        # The exact defect found in production: "y = ax + 9" lost its 9. The
        # old detector excluded it three times over.
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _erasable_page(path, self.SENTENCE)
            self.assertIn("9", self._casualties(path, _word_box(path, "9")))

    def test_a_lost_short_word_is_counted(self) -> None:
        # "of" is two characters, so the catch-all swallowed it as well.
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _erasable_page(path, self.SENTENCE)
            self.assertIn("of", self._casualties(path, _word_box(path, "of")))

    def test_a_lost_mark_allocation_is_counted(self) -> None:
        # "[4]" is what tells a student the question's weight.
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _erasable_page(path, self.SENTENCE)
            self.assertIn("[4]", self._casualties(path, _word_box(path, "[4]")))

    def test_a_box_the_guard_refuses_raises_no_flag(self) -> None:
        """The check and the guard must agree.

        A box that would cover the constant is never painted, so reporting it
        as damage describes an image that does not exist. Checking the raw
        boxes instead held back 1,089 of one subject's 1,570 questions whose
        crops were in fact correct.
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _erasable_page(path, self.SENTENCE)
            self.assertNotIn(
                ISSUE_CROP_ERASED_TEXT, self._run(path, _word_box(path, "9")))

    def test_erasing_the_copyright_line_is_not_flagged(self) -> None:
        # The guard against over-correcting: this is what erase boxes are for.
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _erasable_page(path, self.SENTENCE)
            self.assertNotIn(ISSUE_CROP_ERASED_TEXT, self._run(path, _word_box(path, "UCLES")))

    def test_the_end_of_paper_copyright_block_is_not_damage(self) -> None:
        """The flood this check must not produce.

        Every CAIE question paper ends with the same copyright block, and the
        renderer paints over it on purpose. Reporting those words as destroyed
        question text fired `crop_erased_text` at HIGH severity on the last
        question of every paper in the corpus -- 14,193 flags that describe
        nothing wrong, burying the real losses this check exists to find.
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _notice_page(path)
            span = RootSpan(root_number=12, regions=(
                PageRegion(page=1, bbox=(40.0, 60.0, 560.0, 800.0),
                           erase_bboxes=(_notice_band(path),)),
            ))
            rendered = FakeRendered(12, (FakeStrip(1, (40.0, 60.0, 560.0, 800.0)),))
            issues = {f.issue_type for f in run_crop_checks(path, span, rendered, "qp", 1)}
            self.assertNotIn(ISSUE_CROP_ERASED_TEXT, issues)

    def test_a_constant_inside_the_notice_band_is_still_damage(self) -> None:
        """The exemption is per word, not per box.

        A band that mostly covers boilerplate is still painted, so anything
        real caught underneath it is genuinely gone. "1.8" is not notice
        vocabulary, so it must survive the exemption and be reported.
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _notice_page(path, extra="1.8")
            with fitz.open(path) as document:
                _kept, casualties = _crop_words(
                    document[0], (40.0, 60.0, 560.0, 800.0),
                    (_notice_band(path),), (_notice_band(path),))
            self.assertIn("1.8", casualties)

    def test_a_box_that_touches_nothing_is_not_flagged(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            _erasable_page(path, self.SENTENCE)
            self.assertNotIn(
                ISSUE_CROP_ERASED_TEXT,
                self._run(path, (300.0, 300.0, 360.0, 320.0)),
            )

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


class NumberAnchorTests(unittest.TestCase):
    """The crop is judged against where the detector found the number.

    Before the span carried that, the check asked whether the number sat in the
    top quarter of the crop, and a section heading above it pushed it out --
    so the first question of every section was reported as a crop that does not
    begin at its number. 4,060 flags, 3,075 of them the only thing keeping
    their question out of the published set. Reading the vocabulary above the
    number covered a fixed rubric and could never cover "based on the extract
    from Oppenheimer, by Tom Morton-Smith".
    """

    def _page(self, path: Path) -> None:
        document = fitz.open()
        page = document.new_page(width=595, height=842)
        page.insert_text((50, 70), "SECTION B: DEPTH STUDIES", fontsize=11)
        page.insert_text((50, 92), "Answer any one question from this Section.", fontsize=10)
        page.insert_text((50, 130), "DEPTH STUDY A: THE FIRST WORLD WAR, 1914-18", fontsize=11)
        page.insert_text((50, 170), "9 Military tactics mattered on the Western Front.", fontsize=11)
        page.insert_text((500, 200), "[4]", fontsize=11)
        document.save(path)
        document.close()

    def _issues(self, path: Path, crop, anchor):
        span = RootSpan(
            root_number=9,
            regions=(PageRegion(page=1, bbox=crop),),
            number_anchor=anchor,
        )
        rendered = FakeRendered(9, (FakeStrip(1, crop),))
        return {flag.issue_type for flag in run_crop_checks(path, span, rendered, "qp", 1)}

    def test_a_heading_above_the_number_is_not_a_defect(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            self._page(path)
            issues = self._issues(path, (40.0, 55.0, 560.0, 220.0), (1, 160.0))
            self.assertNotIn(ISSUE_CROP_MISSING_NUMBER, issues)

    def test_a_crop_that_opens_below_its_number_is_reported(self) -> None:
        """The defect the check exists for: the stem is missing.

        0455_s17_qp_23 question 6 rendered starting at "(a) Define 'Central
        Bank'" with nothing above it saying what the question was.
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            self._page(path)
            issues = self._issues(path, (40.0, 185.0, 560.0, 260.0), (1, 160.0))
            self.assertIn(ISSUE_CROP_MISSING_NUMBER, issues)

    def test_a_crop_on_the_wrong_page_does_not_count_as_reaching_it(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            self._page(path)
            issues = self._issues(path, (40.0, 55.0, 560.0, 220.0), (2, 160.0))
            self.assertIn(ISSUE_CROP_MISSING_NUMBER, issues)

    def test_without_an_anchor_the_older_reading_still_applies(self) -> None:
        """Mark schemes and spans built before this carry no anchor."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            self._page(path)
            span = RootSpan(
                root_number=9,
                regions=(PageRegion(page=1, bbox=(40.0, 55.0, 560.0, 220.0)),),
            )
            rendered = FakeRendered(9, (FakeStrip(1, (40.0, 55.0, 560.0, 220.0)),))
            issues = {f.issue_type for f in run_crop_checks(path, span, rendered, "qp", 1)}
            self.assertNotIn(ISSUE_CROP_MISSING_NUMBER, issues)
