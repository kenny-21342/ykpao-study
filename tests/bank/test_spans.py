from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fitz

from pdf_extraction.bank.spans import detect_root_spans


def _mark_scheme_grid(path: Path, rows: list[tuple[str, str, str]]) -> None:
    """Write a landscape mark scheme with a Question/Answer/Marks header."""
    document = fitz.open()
    _draw_grid(document.new_page(width=842, height=595), rows)
    document.save(path)
    document.close()


def _draw_grid(page: fitz.Page, rows: list[tuple[str, str, str]]) -> None:
    columns = (60.0, 200.0, 620.0, 780.0)
    top = 60.0
    height = 40.0

    def rule(y: float) -> None:
        page.draw_line((columns[0], y), (columns[-1], y))

    rule(top)
    page.insert_text((columns[0] + 4, top + 22), "Question", fontsize=11)
    page.insert_text((columns[1] + 4, top + 22), "Answer", fontsize=11)
    page.insert_text((columns[2] + 4, top + 22), "Marks", fontsize=11)
    rule(top + height)

    for index, (label, answer, marks) in enumerate(rows):
        y = top + height * (index + 1)
        page.insert_text((columns[0] + 4, y + 22), label, fontsize=11)
        page.insert_text((columns[1] + 4, y + 22), answer, fontsize=11)
        page.insert_text((columns[2] + 4, y + 22), marks, fontsize=11)
        rule(y + height)

    for x in columns:
        page.draw_line((x, top), (x, top + height * (len(rows) + 1)))


class QuestionPaperSpanTests(unittest.TestCase):
    def test_root_spans_cover_multi_page_questions(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "qp.pdf"
            document = fitz.open()
            first = document.new_page(width=595, height=842)
            first.insert_text((50, 80), "1 Find the value of x.", fontsize=11)
            first.insert_text((50, 400), "2 Explain the observed result.", fontsize=11)
            second = document.new_page(width=595, height=842)
            second.insert_text((50, 70), "Question 2 continued", fontsize=11)
            second.insert_text((75, 110), "Show all required working.", fontsize=11)
            third = document.new_page(width=595, height=842)
            third.insert_text((50, 80), "3 Describe the process.", fontsize=11)
            document.save(path)
            document.close()

            spans = detect_root_spans(path, "qp")

            self.assertEqual(spans.strategy, "prose")
            self.assertEqual(list(spans.root_numbers), [1, 2, 3])
            self.assertEqual(spans.numbering_gaps, ())
            by_root = {span.root_number: span for span in spans.spans}
            self.assertEqual(by_root[1].pages, (1,))
            self.assertEqual(by_root[2].pages, (1, 2))
            self.assertEqual(by_root[3].pages, (3,))

    def test_numbering_gaps_are_reported(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "gap.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 80), "1 Calculate the total.", fontsize=11)
            page.insert_text((50, 300), "2 State the reason.", fontsize=11)
            page.insert_text((50, 520), "4 Describe the outcome.", fontsize=11)
            document.save(path)
            document.close()

            spans = detect_root_spans(path, "qp")

            self.assertEqual(spans.numbering_gaps, (3,))


class MarkSchemeSpanTests(unittest.TestCase):
    def test_table_layout_groups_subparts_under_one_root(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "ms.pdf"
            _mark_scheme_grid(path, [
                ("1(a)", "Correct substitution", "M1"),
                ("1(b)", "Correct evaluation", "A1"),
                ("2", "States the definition", "B1"),
                ("3(a)(i)", "Draws the diagram", "B1"),
            ])

            spans = detect_root_spans(path, "ms")

            self.assertEqual(spans.strategy, "ms_table")
            self.assertEqual(list(spans.root_numbers), [1, 2, 3])
            by_root = {span.root_number: span for span in spans.spans}
            self.assertEqual(by_root[1].part_labels, ("1(a)", "1(b)"))
            self.assertEqual(by_root[3].part_labels, ("3(a)(i)",))

    def test_an_answer_continuing_past_a_page_break_keeps_that_page(self) -> None:
        """A label owns every page up to the next label, not just its own.

        A mark scheme prints a label only where a question or sub-part begins,
        so the pages an answer continues onto carry none. Emitting a region
        only where a label appeared dropped those pages: measured over 45 real
        mark schemes, 51 of 260 answer-body pages (20%) belonged to no region.
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "continuation.pdf"
            document = fitz.open()
            _draw_grid(document.new_page(width=842, height=595), [
                ("1", "first marking point", "B1"),
                ("1(b)", "second marking point", "B1"),
            ])
            # No grid and no label here — this is the page the answer runs onto.
            # It carries the same running header and footer a real page does,
            # which is what puts it over the blank-page threshold.
            middle = document.new_page(width=842, height=595)
            middle.insert_text((60, 40), "0610/51  Cambridge IGCSE - Mark Scheme", fontsize=9)
            middle.insert_text((60, 80), "continued from the previous page", fontsize=11)
            middle.insert_text((60, 110), "further credit is available for any of", fontsize=11)
            middle.insert_text((60, 140), "the alternatives listed in this table", fontsize=11)
            middle.insert_text((60, 560), "(c) UCLES 2023      Page 2 of 3", fontsize=9)
            _draw_grid(document.new_page(width=842, height=595), [
                ("2", "a later question", "B1"),
            ])
            document.save(path)
            document.close()

            spans = detect_root_spans(path, "ms")
            first = next(span for span in spans.spans if span.root_number == 1)
            self.assertIn(2, first.pages)

    def test_answer_text_is_never_read_as_a_question_label(self) -> None:
        """A bare number in the answer column must not create a root.

        This regressed once: scanning the whole row for the first non-empty
        cell turned the "4" in an answer into question 4.
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "ms-numeric.pdf"
            _mark_scheme_grid(path, [
                ("1", "4", "B1"),
                ("2", "17", "B1"),
            ])

            spans = detect_root_spans(path, "ms")

            self.assertEqual(list(spans.root_numbers), [1, 2])


class AnswerKeySpanTests(unittest.TestCase):
    def test_multiple_choice_key_is_recovered_without_spans(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "mcq.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 60), "Question", fontsize=11)
            page.insert_text((150, 60), "Answer", fontsize=11)
            letters = "ABCDABCDABCDABCDABCD"
            for index, letter in enumerate(letters):
                y = 90 + index * 30
                page.insert_text((50, y), str(index + 1), fontsize=11)
                page.insert_text((150, y), letter, fontsize=11)
            document.save(path)
            document.close()

            spans = detect_root_spans(path, "ms")

            self.assertEqual(spans.strategy, "answer_key")
            self.assertEqual(spans.spans, ())
            self.assertEqual(len(spans.answer_key), 20)
            self.assertEqual(spans.answer_key[0], (1, "A"))
            self.assertEqual(spans.answer_key[3], (4, "D"))

    def test_superscripts_do_not_crash_the_key_scanner(self) -> None:
        """str.isdigit() accepts "3²", which int() then rejects."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / "superscript.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 60), "Area is 3² and angle 180⁰", fontsize=11)
            document.save(path)
            document.close()

            spans = detect_root_spans(path, "ms")

            self.assertIsNotNone(spans)


if __name__ == "__main__":
    unittest.main()
