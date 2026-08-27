"""The transcription path, exercised without spending anything.

This path has never run. bank_run_ledger holds no rows, every question in the
store carries model='crop-only', and nothing in the suite touched
`use_model=True` -- while client.py's own docstring records that an earlier
version of the provider client made this stage silently impossible.

So before any money is spent, the provider is stubbed and the whole path is
driven end to end. The assertions are the things that would waste the spend
rather than merely fail it: a run that duplicated rows instead of filling them
in, a ledger that did not resume, a crop verdict quietly upgraded, or a mark
scheme unlinked by the pass that was supposed to enrich it.
"""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import fitz

from pdf_extraction.bank import client, run as run_module
from pdf_extraction.bank.client import CallResult
from pdf_extraction.bank.run import (
    TEXT_INPUT_PER_MTOK,
    TEXT_OUTPUT_PER_MTOK,
    VISION_INPUT_PER_MTOK,
    VISION_OUTPUT_PER_MTOK,
    run_corpus,
)

VISION_IN, VISION_OUT = 1500, 400


def _paper_with_a_bad_crop(path: Path) -> None:
    """One question marked, one not.

    The missing mark allocation has to be local to a question: when no question
    on a paper has one, _drop_paper_wide_marks_flag treats it as a property of
    the paper rather than a broken crop and drops the flag.
    """
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((50, 80), "1 State the name of the process.", fontsize=11)
    page.insert_text((500, 120), "[2]", fontsize=11)
    second = document.new_page(width=595, height=842)
    second.insert_text((50, 80), "2 Describe the observed result.", fontsize=11)
    document.save(path)
    document.close()


def _many_questions(path: Path) -> None:
    """Enough questions that a cap has something to stop part way through.

    Two per page: the span detector wants a question to be followed by more of
    the page, so a page holding exactly one short question yields no roots at
    all.
    """
    document = fitz.open()
    for first in (1, 3, 5, 7, 9, 11):
        page = document.new_page(width=595, height=842)
        page.insert_text((50, 80), f"{first} State the name of the process.", fontsize=11)
        page.insert_text((500, 120), "[2]", fontsize=11)
        page.insert_text((50, 300), f"{first + 1} Describe the observed result.", fontsize=11)
        page.insert_text((500, 340), "[3]", fontsize=11)
    document.save(path)
    document.close()


def _question_paper(path: Path) -> None:
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((50, 80), "1 State the name of the process.", fontsize=11)
    page.insert_text((500, 120), "[2]", fontsize=11)
    second = document.new_page(width=595, height=842)
    second.insert_text((50, 80), "2 Describe the observed result.", fontsize=11)
    second.insert_text((500, 120), "[4]", fontsize=11)
    document.save(path)
    document.close()


class _Provider:
    """A stand-in for the vision model that counts how often it is asked."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, *args, **kwargs) -> CallResult:
        self.calls += 1
        return CallResult(
            content={
                "root_number": "1",
                "body_md": "State the name of the process.",
                "parts": [],
                "total_marks": 2,
                "figures_used": [],
                "confidence": 0.9,
                "notes": "",
            },
            model="stub-vision",
            response_id=None,
            attempts=1,
            input_tokens=VISION_IN,
            output_tokens=VISION_OUT,
        )


def _settings() -> dict[str, object]:
    return {
        "endpoint": "https://stub.invalid/v1/chat/completions",
        "api_key": "stub",
        "model": "stub-vision",
        "max_attempts": 1,
        "timeout_seconds": 5,
    }


class ModelRunTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = TemporaryDirectory()
        self.root = Path(self._directory.name)
        self.db = self.root / "bank.db"
        self.pdf = self.root / "0610_s23_qp_41.pdf"
        _question_paper(self.pdf)
        self.provider = _Provider()

    def tearDown(self) -> None:
        self._directory.cleanup()

    def _run(self, *, use_model: bool, max_spend_usd: float | None = None,
             concurrency: int = 4):
        with mock.patch.object(run_module, "load_vision", _settings, create=True), \
             mock.patch("pdf_extraction.bank.env.vision_settings", _settings), \
             mock.patch("pdf_extraction.bank.env.text_settings", _settings), \
             mock.patch("pdf_extraction.bank.transcribe.call_json", self.provider), \
             mock.patch("pdf_extraction.bank.tag.call_json", self.provider):
            return run_corpus(
                [self.pdf],
                db_path=self.db,
                asset_root=self.root / "assets",
                use_model=use_model,
                max_spend_usd=max_spend_usd,
                concurrency=concurrency,
                do_tagging=False,
                log=lambda message: None,
            )

    def _questions(self) -> list[sqlite3.Row]:
        connection = sqlite3.connect(self.db)
        connection.row_factory = sqlite3.Row
        try:
            return connection.execute(
                "SELECT id, root_number, body_md, model, status FROM bank_questions "
                "ORDER BY root_number"
            ).fetchall()
        finally:
            connection.close()

    def test_a_transcription_fills_the_crop_only_row_rather_than_adding_one(self) -> None:
        # The upsert is keyed on (paper_id, root_number). If that ever breaks,
        # a transcription run doubles the bank instead of enriching it.
        self._run(use_model=False)
        before = self._questions()
        self.assertTrue(before)
        self.assertTrue(all(row["model"] == "crop-only" for row in before))

        self._run(use_model=True)
        after = self._questions()

        self.assertEqual([row["id"] for row in after], [row["id"] for row in before])
        self.assertTrue(all(row["body_md"].strip() for row in after))
        self.assertTrue(all(row["model"] != "crop-only" for row in after))

    def test_a_second_run_asks_the_provider_nothing(self) -> None:
        # Resume is per question via bank_run_ledger. Without it, re-running a
        # subject after an interruption pays for the whole subject again.
        self._run(use_model=False)
        self._run(use_model=True)
        first_pass = self.provider.calls
        self.assertGreater(first_pass, 0)

        self._run(use_model=True)
        self.assertEqual(self.provider.calls, first_pass)

    def test_the_ledger_records_what_was_paid_for(self) -> None:
        self._run(use_model=False)
        self._run(use_model=True)

        connection = sqlite3.connect(self.db)
        try:
            rows = connection.execute(
                "SELECT stage, status, input_tokens, output_tokens FROM bank_run_ledger"
            ).fetchall()
        finally:
            connection.close()

        self.assertTrue(rows)
        self.assertTrue(all(row[1] == "ok" for row in rows))
        self.assertEqual(sum(row[2] for row in rows), VISION_IN * self.provider.calls)

    def test_the_reported_cost_matches_the_tokens_actually_used(self) -> None:
        # The spend cap will be built on this number, so it has to be right.
        self._run(use_model=False)
        stats = self._run(use_model=True)

        expected = (
            stats.vision_input_tokens / 1e6 * VISION_INPUT_PER_MTOK
            + stats.vision_output_tokens / 1e6 * VISION_OUTPUT_PER_MTOK
            + stats.text_input_tokens / 1e6 * TEXT_INPUT_PER_MTOK
            + stats.text_output_tokens / 1e6 * TEXT_OUTPUT_PER_MTOK
        )
        self.assertAlmostEqual(stats.cost_usd, expected, places=10)
        self.assertEqual(stats.vision_input_tokens, VISION_IN * self.provider.calls)

    def test_a_question_held_back_by_its_crop_is_not_published_by_transcription(self) -> None:
        """Transcribing a bad crop must not promote it.

        Status is recomputed from the flags the transcription pass raises,
        which are about the text. A question held back because the image is
        wrong -- a cut-off number, an erased stem -- has a problem the model
        cannot see and does not fix, so letting the pass decide alone would
        publish exactly the questions the crop QA was protecting students from.
        """
        bad = self.root / "0610_s23_qp_42.pdf"
        _paper_with_a_bad_crop(bad)
        self.pdf = bad

        self._run(use_model=False)
        before = {row["root_number"]: row["status"] for row in self._questions()}
        self.assertIn("needs_review", before.values(), "fixture did not produce a bad crop")

        self._run(use_model=True)
        after = {row["root_number"]: row["status"] for row in self._questions()}

        for root, status in before.items():
            if status == "needs_review":
                self.assertEqual(
                    after[root], "needs_review",
                    f"question {root} was published despite its crop being flagged",
                )

    def test_a_linked_mark_scheme_stays_linked(self) -> None:
        """The pass enriches mark schemes; it must not unlink them.

        upsert_mark_scheme is called with question_id=None on every path,
        because the link is made later by link_mark_schemes_to_questions. It
        used to assign that None straight in.
        """
        self._run(use_model=False)
        connection = sqlite3.connect(self.db)
        try:
            question_id = connection.execute(
                "SELECT id FROM bank_questions ORDER BY id LIMIT 1"
            ).fetchone()[0]
            paper_id = connection.execute(
                "SELECT id FROM bank_papers ORDER BY id LIMIT 1"
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO bank_mark_schemes (paper_id, root_number, answer_md, "
                "status, question_id) VALUES (?, 99, '', 'published', ?)",
                (paper_id, question_id),
            )
            connection.commit()
        finally:
            connection.close()

        self._run(use_model=True)

        connection = sqlite3.connect(self.db)
        try:
            still = connection.execute(
                "SELECT question_id FROM bank_mark_schemes WHERE root_number = 99"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(still, question_id)

    def test_the_spend_cap_stops_the_run(self) -> None:
        """A cap that only reports is not a cap.

        Every item is billed, so the decision to spend more has to be taken
        after the last result came back. Submitting the whole subject upfront
        would make the cap a suggestion: the money is already committed by the
        time the first total is known.
        """
        paper = self.root / "0610_s23_qp_43.pdf"
        _many_questions(paper)
        self.pdf = paper

        self._run(use_model=False)
        uncapped_items = len(self._questions())
        self.assertGreater(uncapped_items, 2, "fixture needs several questions")

        # One item costs a known amount; allow just over one of them.
        one_item = (VISION_IN / 1e6 * VISION_INPUT_PER_MTOK
                    + VISION_OUT / 1e6 * VISION_OUTPUT_PER_MTOK)
        # One worker, so the in-flight window is two items rather than eight.
        # The cap bounds what is started, and whatever is already running when
        # it trips still finishes -- so the assertion is that it stopped well
        # short, not that it stopped at exactly two.
        stats = self._run(
            use_model=True, max_spend_usd=one_item * 2, concurrency=1)

        self.assertLess(self.provider.calls, uncapped_items)
        self.assertLessEqual(stats.cost_usd, one_item * uncapped_items)

    def test_no_cap_still_runs_everything(self) -> None:
        paper = self.root / "0610_s23_qp_44.pdf"
        _many_questions(paper)
        self.pdf = paper

        self._run(use_model=False)
        expected = len(self._questions())
        self._run(use_model=True)

        self.assertEqual(self.provider.calls, expected)
