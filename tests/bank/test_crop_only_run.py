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
