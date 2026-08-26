"""Linking a mark scheme to its question, without guessing.

`store.link_mark_schemes_to_questions` did this in one correlated UPDATE.
`bank_mark_schemes.question_id` is UNIQUE, and IB option papers collapse to a
single identity -- a Mathematics paper 3 identity is shared by the Calculus,
Discrete, Sets and Statistics mark schemes -- so the statement tried to give one
question to several rows, hit the constraint, and SQLite rolled the whole
statement back. Not one row was linked, for the entire corpus.

Two properties matter here: a collision must cost one row rather than all of
them, and an ambiguous pairing must be reported rather than resolved by
whichever row the database happened to return first. Attaching a Calculus mark
scheme to a Statistics question is worse than attaching none.
"""

from __future__ import annotations

import sqlite3
import unittest

from pdf_extraction.bank import store
from pdf_extraction.bank.relink_mark_schemes import plan_links
from pdf_extraction.bank.store import PaperIdentity


class RelinkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(store.SCHEMA_PATH.read_text(encoding="utf-8"))
        self.subject_id = store.upsert_subject(
            self.connection, board="IB", code="mathematics", name="Mathematics", level="HL"
        )

    def tearDown(self) -> None:
        self.connection.close()

    def _paper(self, doc_type: str, source_path: str) -> int:
        return store.upsert_paper(
            self.connection,
            subject_id=self.subject_id,
            identity=PaperIdentity(
                code="mathematics", board="IB", year=2016, session="May",
                paper_number=3, variant=0, doc_type=doc_type, level="HL",
            ),
            source_path=source_path, source_sha256=source_path.ljust(64, "x")[:64],
            page_count=1, span_strategy="prose", used_ocr=False,
        )

    def _question(self, paper_id: int, root: int) -> int:
        return int(self.connection.execute(
            "INSERT INTO bank_questions (paper_id, root_number, body_md, status) "
            "VALUES (?, ?, '', 'published')", (paper_id, root),
        ).lastrowid)

    def _mark_scheme(self, paper_id: int, root: int) -> int:
        return int(self.connection.execute(
            "INSERT INTO bank_mark_schemes (paper_id, root_number, answer_md, status) "
            "VALUES (?, ?, '', 'published')", (paper_id, root),
        ).lastrowid)

    def test_an_unambiguous_pairing_is_linked(self) -> None:
        question_paper = self._paper("qp", "/papers/Mathematics_paper_3_Calculus__HL.pdf")
        mark_paper = self._paper("ms", "/papers/Mathematics_paper_3_Calculus__HL_ms.pdf")
        question_id = self._question(question_paper, 1)
        ms_id = self._mark_scheme(mark_paper, 1)

        links, ambiguous = plan_links(self.connection)

        self.assertEqual(links, [(question_id, ms_id)])
        self.assertEqual(ambiguous, [])

    def test_option_papers_sharing_an_identity_are_refused(self) -> None:
        # The real IB case. Four option papers, one identity: any link here
        # would be a coin toss recorded as fact.
        for option in ("Calculus", "Discrete", "Sets", "Statistics"):
            paper = self._paper("qp", f"/papers/Mathematics_paper_3_{option}__HL.pdf")
            self._question(paper, 1)
        mark_paper = self._paper("ms", "/papers/Mathematics_paper_3_Calculus__HL_ms.pdf")
        self._mark_scheme(mark_paper, 1)

        links, ambiguous = plan_links(self.connection)

        self.assertEqual(links, [])
        self.assertEqual(len(ambiguous), 1)
        self.assertEqual(ambiguous[0]["reason"], "one mark scheme, several questions")

    def test_a_question_already_claimed_is_not_offered_again(self) -> None:
        # question_id is UNIQUE; offering a claimed question is what produced
        # the collision that aborted the statement.
        question_paper = self._paper("qp", "/papers/Mathematics_paper_3_Calculus__HL.pdf")
        first_ms = self._paper("ms", "/papers/Mathematics_paper_3_Calculus__HL_ms.pdf")
        question_id = self._question(question_paper, 1)
        taken = self._mark_scheme(first_ms, 1)
        self.connection.execute(
            "UPDATE bank_mark_schemes SET question_id = ? WHERE id = ?",
            (question_id, taken),
        )
        second_ms = self._paper("ms", "/papers/Mathematics_paper_3_Calculus__HL_ms_Spa.pdf")
        self._mark_scheme(second_ms, 1)

        links, ambiguous = plan_links(self.connection)

        self.assertEqual(links, [])
        self.assertEqual(ambiguous, [])

    def test_a_mark_scheme_with_no_question_paper_is_left_alone(self) -> None:
        mark_paper = self._paper("ms", "/papers/Mathematics_paper_3_Calculus__HL_ms.pdf")
        self._mark_scheme(mark_paper, 1)

        links, ambiguous = plan_links(self.connection)

        self.assertEqual(links, [])
        self.assertEqual(ambiguous, [])
