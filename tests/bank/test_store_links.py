"""The mark-scheme link must survive everything that writes over the row.

A mark scheme is stored before its question paper's questions necessarily
exist, so `question_id` is filled in afterwards by
`link_mark_schemes_to_questions`. Every caller of `upsert_mark_scheme` passes
`question_id=None` for that reason.

The UPDATE branch used to assign that None straight into the column, so any
later pass over the same paper -- a re-render, or the transcription stage --
silently unlinked a mark scheme that had already been linked. Repairing the
21,667 unlinked rows and then re-rendering would have undone the repair without
a single error being raised.
"""

from __future__ import annotations

import sqlite3
import unittest

from pdf_extraction.bank import store
from pdf_extraction.bank.store import PaperIdentity
from pdf_extraction.bank.transcribe import MarkSchemeTranscription


def _transcription() -> MarkSchemeTranscription:
    return MarkSchemeTranscription(
        root_number="1",
        answer_md="the expected answer",
        marking_points=[],
        total_marks=2,
        answer_letter=None,
        confidence=0.9,
        notes="",
    )


class MarkSchemeLinkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(store.SCHEMA_PATH.read_text(encoding="utf-8"))
        subject_id = store.upsert_subject(
            self.connection, board="CAIE", code="0625", name="Physics", level="igcse"
        )
        self.paper_id = store.upsert_paper(
            self.connection,
            subject_id=subject_id,
            identity=PaperIdentity(
                code="0625", board="CAIE", year=2023, session="s",
                paper_number=4, variant=1, doc_type="ms",
            ),
            source_path="/tmp/0625_s23_ms_41.pdf", source_sha256="a" * 64,
            page_count=1, span_strategy="ms_table", used_ocr=False,
        )

        # A real question for the link to point at: question_id carries a
        # foreign key, so the regression cannot be exercised with a made-up id.
        question_paper_id = store.upsert_paper(
            self.connection,
            subject_id=subject_id,
            identity=PaperIdentity(
                code="0625", board="CAIE", year=2023, session="s",
                paper_number=4, variant=1, doc_type="qp",
            ),
            source_path="/tmp/0625_s23_qp_41.pdf", source_sha256="b" * 64,
            page_count=1, span_strategy="prose", used_ocr=False,
        )
        cursor = self.connection.execute(
            "INSERT INTO bank_questions (paper_id, root_number, body_md, status) "
            "VALUES (?, 1, '', 'published')",
            (question_paper_id,),
        )
        self.question_id = int(cursor.lastrowid)

    def tearDown(self) -> None:
        self.connection.close()

    def _upsert(self, question_id: int | None) -> int:
        return store.upsert_mark_scheme(
            self.connection, paper_id=self.paper_id, transcription=_transcription(),
            question_id=question_id, run_id="test", model="test",
            prompt_version="v1", status="published",
        )

    def _question_id(self, mark_scheme_id: int) -> int | None:
        row = self.connection.execute(
            "SELECT question_id FROM bank_mark_schemes WHERE id = ?", (mark_scheme_id,)
        ).fetchone()
        return row["question_id"]

    def test_a_link_survives_a_later_pass_that_does_not_know_about_it(self) -> None:
        # The regression. Re-rendering and transcription both re-upsert with
        # question_id=None, which used to wipe the link.
        mark_scheme_id = self._upsert(None)
        self.connection.execute(
            "UPDATE bank_mark_schemes SET question_id = ? WHERE id = ?",
            (self.question_id, mark_scheme_id),
        )

        self.assertEqual(self._upsert(None), mark_scheme_id)
        self.assertEqual(self._question_id(mark_scheme_id), self.question_id)

    def test_an_explicit_link_is_still_written(self) -> None:
        # COALESCE must not make the column read-only.
        mark_scheme_id = self._upsert(None)
        self.assertIsNone(self._question_id(mark_scheme_id))

        self._upsert(self.question_id)
        self.assertEqual(self._question_id(mark_scheme_id), self.question_id)
