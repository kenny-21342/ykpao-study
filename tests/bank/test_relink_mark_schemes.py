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
from pdf_extraction.bank.relink_mark_schemes import option_tokens, plan_links
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

    def test_several_mark_schemes_competing_for_one_question_are_refused(self) -> None:
        """The reverse collision, which no filename can settle.

        One question paper, several mark schemes claiming it. question_id is
        UNIQUE so at most one can win, and nothing in the names says which
        should -- so none does. This is the direction the option tiebreak
        deliberately does not touch.
        """
        question_paper = self._paper("qp", "/papers/Mathematics_paper_3_Calculus__HL.pdf")
        self._question(question_paper, 1)
        for suffix in ("_markscheme", "_markscheme_Spa"):
            mark_paper = self._paper(
                "ms", f"/papers/Mathematics_paper_3_Calculus__HL{suffix}.pdf")
            self._mark_scheme(mark_paper, 1)

        links, ambiguous = plan_links(self.connection)

        # Each mark scheme is reported, so the pair yields two entries.
        self.assertEqual(links, [])
        self.assertTrue(ambiguous)
        self.assertTrue(all(
            entry["reason"] == "several mark schemes, one question"
            for entry in ambiguous
        ))

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


class OptionTiebreakTests(unittest.TestCase):
    """Which option a paper is, read from its filename.

    IB option papers share one identity, so pairing them needs the only thing
    that distinguishes them: the option named in the filename. It is not
    written identically on both sides -- one paper says "the_Middle_East" where
    its mark scheme says "the_ME" -- so the match is by overlap with a margin,
    not by equality.
    """

    def test_the_option_is_read_from_after_the_paper_number(self) -> None:
        self.assertEqual(
            option_tokens("/x/Mathematics_paper_3_Calculus__HL_markscheme.pdf"),
            frozenset({"calculus"}),
        )

    def test_level_and_document_suffixes_are_not_part_of_the_option(self) -> None:
        # Otherwise every HL paper looks like every other HL paper.
        plain = option_tokens("/x/Mathematics_paper_3_Calculus__HL.pdf")
        scheme = option_tokens("/x/Mathematics_paper_3_Calculus__HL_markscheme.pdf")
        translated = option_tokens("/x/Mathematics_paper_3_Calculus__HL_markscheme_Spa.pdf")
        self.assertEqual(plain, scheme)
        self.assertEqual(plain, translated)

    def test_a_paper_with_no_option_names_none(self) -> None:
        self.assertEqual(option_tokens("/x/0625_s23_qp_41.pdf"), frozenset())

    def test_the_clearer_option_wins_a_shared_identity(self) -> None:
        """Four option papers, one identity, one mark scheme.

        Without this the whole group is refused and every IB option paper keeps
        no mark scheme at all. With it, the one naming the same option is
        taken and the rest are left alone.
        """
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.executescript(store.SCHEMA_PATH.read_text(encoding="utf-8"))
        subject_id = store.upsert_subject(
            connection, board="IB", code="mathematics", name="Mathematics", level="HL"
        )

        def paper(doc_type: str, option: str, suffix: str = "") -> int:
            return store.upsert_paper(
                connection,
                subject_id=subject_id,
                identity=PaperIdentity(
                    code="mathematics", board="IB", year=2016, session="May",
                    paper_number=3, variant=0, doc_type=doc_type, level="HL",
                ),
                source_path=f"/papers/Mathematics_paper_3_{option}__HL{suffix}.pdf",
                source_sha256=f"{doc_type}{option}".ljust(64, "x")[:64],
                page_count=1, span_strategy="prose", used_ocr=False,
            )

        wanted = None
        for option in ("Calculus", "Discrete_mathematics",
                       "Sets_relations_and_groups", "Statistics_and_probability"):
            question_paper = paper("qp", option)
            question_id = int(connection.execute(
                "INSERT INTO bank_questions (paper_id, root_number, body_md, status) "
                "VALUES (?, 1, '', 'published')", (question_paper,),
            ).lastrowid)
            if option == "Discrete_mathematics":
                wanted = question_id

        mark_paper = paper("ms", "Discrete_mathematics", "_markscheme")
        ms_id = int(connection.execute(
            "INSERT INTO bank_mark_schemes (paper_id, root_number, answer_md, status) "
            "VALUES (?, 1, '', 'published')", (mark_paper,),
        ).lastrowid)

        links, ambiguous = plan_links(connection)
        connection.close()

        self.assertEqual(links, [(wanted, ms_id)])
        self.assertEqual(ambiguous, [])

    def test_options_that_are_all_equally_unlike_are_still_refused(self) -> None:
        """No clear winner means no guess.

        The margin is what keeps this honest: a mark scheme naming no option,
        or naming one no question paper shares, must not be attached to
        whichever row happens to come first.
        """
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.executescript(store.SCHEMA_PATH.read_text(encoding="utf-8"))
        subject_id = store.upsert_subject(
            connection, board="IB", code="history", name="History", level="HL"
        )

        def paper(doc_type: str, tail: str) -> int:
            return store.upsert_paper(
                connection,
                subject_id=subject_id,
                identity=PaperIdentity(
                    code="history", board="IB", year=2016, session="May",
                    paper_number=1, variant=0, doc_type=doc_type, level="HL",
                ),
                source_path=f"/papers/History_paper_1_{tail}.pdf",
                source_sha256=f"{doc_type}{tail}".ljust(64, "x")[:64],
                page_count=1, span_strategy="prose", used_ocr=False,
            )

        for option in ("Communism_in_crisis__HL", "Peacemaking__HL"):
            question_paper = paper("qp", option)
            connection.execute(
                "INSERT INTO bank_questions (paper_id, root_number, body_md, status) "
                "VALUES (?, 1, '', 'published')", (question_paper,),
            )
        mark_paper = paper("ms", "Rights_and_protest__HL_markscheme")
        connection.execute(
            "INSERT INTO bank_mark_schemes (paper_id, root_number, answer_md, status) "
            "VALUES (?, 1, '', 'published')", (mark_paper,),
        )

        links, ambiguous = plan_links(connection)
        connection.close()

        self.assertEqual(links, [])
        self.assertEqual(len(ambiguous), 1)
