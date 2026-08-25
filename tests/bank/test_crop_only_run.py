"""A run with no model must still produce questions.

Crop-first ships the image as the product, so phase A has to write rows on its
own. It previously returned early whenever use_model was false, which meant the
whole corpus could be segmented and rendered and still contain no questions.
"""

from __future__ import annotations

from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

import fitz

from pdf_extraction.bank.run import run_corpus


def _mark_scheme(path: Path) -> None:
    """A grid answering the two questions in _question_paper."""
    document = fitz.open()
    page = document.new_page(width=842, height=595)
    columns = (60.0, 200.0, 620.0, 780.0)
    top, height = 60.0, 40.0
    for index in range(4):
        page.draw_line((columns[0], top + height * index), (columns[-1], top + height * index))
    page.insert_text((columns[0] + 4, top + 22), "Question", fontsize=11)
    page.insert_text((columns[1] + 4, top + 22), "Answer", fontsize=11)
    page.insert_text((columns[2] + 4, top + 22), "Marks", fontsize=11)
    for index, (label, answer) in enumerate((("1", "the first answer"), ("2", "the second answer"))):
        y = top + height * (index + 1)
        page.insert_text((columns[0] + 4, y + 22), label, fontsize=11)
        page.insert_text((columns[1] + 4, y + 22), answer, fontsize=11)
        page.insert_text((columns[2] + 4, y + 22), "2", fontsize=11)
    for x in columns:
        page.draw_line((x, top), (x, top + height * 3))
    document.save(path)
    document.close()


def _question_paper(path: Path) -> None:
    document = fitz.open()
    first = document.new_page(width=595, height=842)
    first.insert_text((50, 80), "1 State the name of the process.", fontsize=11)
    first.insert_text((500, 120), "[2]", fontsize=11)
    second = document.new_page(width=595, height=842)
    second.insert_text((50, 70), "Question 1 continued", fontsize=11)
    second.insert_text((75, 110), "Explain your reasoning in full.", fontsize=11)
    second.insert_text((500, 150), "[3]", fontsize=11)
    third = document.new_page(width=595, height=842)
    third.insert_text((50, 80), "2 Describe the observed result.", fontsize=11)
    third.insert_text((500, 120), "[4]", fontsize=11)
    document.save(path)
    document.close()


class CropOnlyRunTests(unittest.TestCase):
    def test_a_model_free_run_writes_questions_and_every_strip(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pdf_path = root / "0610_s23_qp_41.pdf"
            _question_paper(pdf_path)

            stats = run_corpus(
                [pdf_path],
                db_path=root / "bank.db",
                asset_root=root / "assets",
                use_model=False,
                log=lambda message: None,
            )

            connection = sqlite3.connect(root / "bank.db")
            connection.row_factory = sqlite3.Row
            questions = connection.execute(
                "SELECT id, root_number, status FROM bank_questions ORDER BY root_number"
            ).fetchall()
            self.assertEqual([row["root_number"] for row in questions], [1, 2])
            self.assertEqual(stats.questions, 2)

            # Every strip is linked, not just the one screenshot_id holds.
            for row in questions:
                strips = connection.execute(
                    "SELECT ordering, page FROM bank_question_strips "
                    "WHERE question_id = ? ORDER BY ordering",
                    (row["id"],),
                ).fetchall()
                self.assertTrue(strips, f"question {row['root_number']} linked no strips")
                self.assertEqual(
                    [strip["ordering"] for strip in strips],
                    list(range(len(strips))),
                    "strip ordering must be dense and start at zero",
                )

            # Question 1 runs across a page break, so it needs more than one.
            first = next(row for row in questions if row["root_number"] == 1)
            count = connection.execute(
                "SELECT COUNT(*) FROM bank_question_strips WHERE question_id = ?",
                (first["id"],),
            ).fetchone()[0]
            self.assertGreater(count, 1)

            # And the row still points at strip 0 for anything reading the old
            # column.
            screenshot = connection.execute(
                "SELECT screenshot_id FROM bank_questions WHERE id = ?", (first["id"],)
            ).fetchone()[0]
            self.assertIsNotNone(screenshot)
            connection.close()

    def test_a_mark_scheme_is_paired_with_the_question_it_answers(self) -> None:
        """The pairing needs both documents, so nothing during one can make it.

        bank_mark_schemes.question_id was NULL for every row ever written until
        this ran, which meant a mark scheme could never be shown beside its
        question.
        """
        with TemporaryDirectory() as directory:
            root = Path(directory)
            # Same sitting: everything but doc_type matches.
            _question_paper(root / "0610_s23_qp_41.pdf")
            _mark_scheme(root / "0610_s23_ms_41.pdf")

            run_corpus(
                [root / "0610_s23_qp_41.pdf", root / "0610_s23_ms_41.pdf"],
                db_path=root / "bank.db",
                asset_root=root / "assets",
                use_model=False,
                log=lambda message: None,
            )

            connection = sqlite3.connect(root / "bank.db")
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                """
                SELECT m.root_number, m.question_id, q.root_number AS question_root
                FROM bank_mark_schemes m
                LEFT JOIN bank_questions q ON q.id = m.question_id
                ORDER BY m.root_number
                """
            ).fetchall()
            self.assertTrue(rows, "no mark schemes were stored")
            for row in rows:
                self.assertIsNotNone(
                    row["question_id"],
                    f"mark scheme {row['root_number']} was left unpaired",
                )
                self.assertEqual(row["root_number"], row["question_root"])
            connection.close()

    def test_no_model_run_spends_nothing(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pdf_path = root / "0610_s23_qp_41.pdf"
            _question_paper(pdf_path)
            stats = run_corpus(
                [pdf_path],
                db_path=root / "bank.db",
                asset_root=root / "assets",
                use_model=False,
                log=lambda message: None,
            )
            self.assertEqual(stats.cost_usd, 0.0)
            # RunStats.billed_items counts rows produced rather than calls
            # paid for, so it reads 2 here despite nothing being spent. Left
            # alone: the number it reports is still the one the cost-per-item
            # figure needs, and cost_usd is the honest check.
            self.assertEqual(stats.vision_input_tokens, 0)
            self.assertEqual(stats.text_input_tokens, 0)


if __name__ == "__main__":
    unittest.main()
