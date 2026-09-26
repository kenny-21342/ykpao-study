"""A chunked transcription run has to be able to walk the corpus.

`already_done` asks whether a paper has been *cropped*, which is the right
question for finishing an interrupted crop run and useless for a model run --
every paper has been cropped, so it would skip everything. The resume filter
was therefore switched off entirely for `--use-model`, which meant `--chunk`
took the same first N papers every time and the run could never reach paper
N+1. A transcription run had to be one process covering all 14,193 papers,
nine hours of re-rendering before the first model call.
"""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from pdf_extraction.bank import corpus_run, store


class TranscribedResumeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.db = Path(self._directory.name) / "extract.db"
        connection = sqlite3.connect(self.db)
        connection.row_factory = sqlite3.Row
        connection.executescript(store.SCHEMA_PATH.read_text(encoding="utf-8"))
        self.connection = connection
        self.addCleanup(connection.close)
        self.subject_id = store.upsert_subject(
            connection, board="CAIE", code="0610", name="Biology", level="igcse")

    def _paper(self, name: str, sha: str, doc_type: str = "qp") -> int:
        return store.upsert_paper(
            self.connection,
            subject_id=self.subject_id,
            identity=store.PaperIdentity(
                code="0610", board="CAIE", year=2023, session="s",
                paper_number=4, variant=1, doc_type=doc_type,
            ),
            source_path=f"/corpus/{name}", source_sha256=sha,
            page_count=2, span_strategy="prose", used_ocr=False,
        )

    def _question(self, paper_id: int, root: int) -> None:
        self.connection.execute(
            "INSERT INTO bank_questions (paper_id, root_number, body_md, status) "
            "VALUES (?, ?, '', 'published')", (paper_id, root))

    def _ledger(self, sha: str, root: int, status: str = "ok",
                completed_at: str | None = None) -> None:
        # `completed_at` matters only for the IB rubric rule, which uses the
        # date to tell a pre-fix success from a post-fix one. Everything else
        # is happy with the column default.
        if completed_at is None:
            self.connection.execute(
                "INSERT INTO bank_run_ledger (work_key, stage, source_sha256, "
                "root_number, status) VALUES (?, 'transcribe', ?, ?, ?)",
                (f"{sha}-{root}", sha, root, status))
        else:
            self.connection.execute(
                "INSERT INTO bank_run_ledger (work_key, stage, source_sha256, "
                "root_number, status, completed_at) VALUES (?, 'transcribe', ?, ?, ?, ?)",
                (f"{sha}-{root}", sha, root, status, completed_at))

    def _finished(self) -> set[str]:
        self.connection.commit()
        with mock.patch.object(corpus_run, "DB", self.db):
            return corpus_run.transcribed()

    def test_a_paper_with_every_root_transcribed_is_finished(self) -> None:
        paper = self._paper("done.pdf", "a" * 64)
        self._question(paper, 1)
        self._question(paper, 2)
        self._ledger("a" * 64, 1)
        self._ledger("a" * 64, 2)
        self.assertIn("/corpus/done.pdf", self._finished())

    def test_a_partly_transcribed_paper_is_not_finished(self) -> None:
        paper = self._paper("partial.pdf", "b" * 64)
        self._question(paper, 1)
        self._question(paper, 2)
        self._ledger("b" * 64, 1)
        self.assertNotIn("/corpus/partial.pdf", self._finished())

    def test_duplicate_successes_across_models_do_not_finish_a_paper(self) -> None:
        paper = self._paper("duplicate.pdf", "z" * 64)
        self._question(paper, 1)
        self._question(paper, 2)
        self._ledger("z" * 64, 1)
        self.connection.execute(
            "INSERT INTO bank_run_ledger (work_key, stage, source_sha256, "
            "root_number, status) VALUES (?, 'transcribe', ?, 1, 'ok')",
            ("another-model-root-1", "z" * 64),
        )
        self.assertNotIn("/corpus/duplicate.pdf", self._finished())

    def test_a_failed_entry_does_not_count_as_transcribed(self) -> None:
        paper = self._paper("failed.pdf", "c" * 64)
        self._question(paper, 1)
        self._ledger("c" * 64, 1, status="failed")
        self.assertNotIn("/corpus/failed.pdf", self._finished())

    def test_an_oversized_root_is_retried_after_chunking(self) -> None:
        paper = self._paper("large.pdf", "g" * 64)
        self._question(paper, 1)
        self._ledger("g" * 64, 1, status="skipped")
        self.assertNotIn("/corpus/large.pdf", self._finished())

    def test_ib_rubric_root_zero_is_reprocessed(self) -> None:
        """A success from *before* the detector fix does not count.

        The ledger date is what separates this from the test below: this
        paper's root 0 was marked ok by the old prose detector, so it still
        needs one revisit.
        """
        name = "IB PAST PAPERS - YEAR/economics_ms.pdf"
        paper = self._paper(name, "h" * 64, doc_type="ms")
        self.connection.execute(
            "INSERT INTO bank_mark_schemes (paper_id, root_number, answer_md, status) "
            "VALUES (?, 0, 'rubric level', 'published')", (paper,))
        self._ledger("h" * 64, 0, completed_at="2026-09-01 00:00:00")
        self.assertNotIn(f"/corpus/{name}", self._finished())

    def test_an_ib_rubric_paper_is_not_revisited_forever(self) -> None:
        """The bound on the rule above.

        Re-running one of these papers does not clear its root 0, so without a
        stopping condition the same predicate matches on every pass. On 25 Sep
        that held the corpus at 99.85%: 16 consecutive chunks over the same 22
        papers, each "finished cleanly" while the ledger never moved. A
        root-0 success recorded after the detector was fixed means the
        revisit has happened, and the paper is done.
        """
        name = "IB PAST PAPERS - YEAR/philosophy_ms.pdf"
        paper = self._paper(name, "i" * 64, doc_type="ms")
        self.connection.execute(
            "INSERT INTO bank_mark_schemes (paper_id, root_number, answer_md, status) "
            "VALUES (?, 0, 'rubric level', 'published')", (paper,))
        self.connection.execute(
            "INSERT INTO bank_run_ledger (work_key, stage, source_sha256, root_number, "
            "status, completed_at) VALUES (?, 'transcribe', ?, 0, 'ok', ?)",
            ("revisited-key", "i" * 64, "2026-09-25 08:54:27"))
        self.connection.commit()
        self.assertIn(f"/corpus/{name}", self._finished())

    def test_an_answer_key_mark_scheme_needs_no_model_call(self) -> None:
        """Stage 1 recovers the whole key, so there is nothing left to bill."""
        paper = self._paper("key_ms.pdf", "d" * 64, doc_type="ms")
        for root, letter in ((1, "A"), (2, "C")):
            self.connection.execute(
                "INSERT INTO bank_mark_schemes (paper_id, root_number, answer_md, "
                "answer_letter, status) VALUES (?, ?, '', ?, 'published')",
                (paper, root, letter))
        self.assertIn("/corpus/key_ms.pdf", self._finished())

    def test_a_prose_mark_scheme_still_needs_transcribing(self) -> None:
        paper = self._paper("prose_ms.pdf", "e" * 64, doc_type="ms")
        self.connection.execute(
            "INSERT INTO bank_mark_schemes (paper_id, root_number, answer_md, "
            "answer_letter, status) VALUES (?, 1, '', NULL, 'published')", (paper,))
        self.assertNotIn("/corpus/prose_ms.pdf", self._finished())

    def test_a_rendered_paper_with_nothing_in_it_is_finished(self) -> None:
        """An insert booklet has no questions and no mark scheme.

        Neither existing branch admitted this shape, so 482 papers -- insert
        and resource booklets, and mark schemes whose layout defeated the
        segmenter -- stayed `remaining` permanently. Every chunk re-selected
        and re-rendered them, and on 19 Sep that stalled the run: chunks spent
        eight minutes of phase A to queue four items, and papers completed per
        hour fell from 115 to 20 with 81,586 real items still waiting.
        """
        self._paper("0509_s15_in_11.pdf", "insert-sha", doc_type="in")
        self.assertIn("/corpus/0509_s15_in_11.pdf", self._finished())

    def test_numbered_text_in_an_insert_is_not_a_billable_question(self) -> None:
        paper = self._paper("0500_s24_in_11.pdf", "numbered-insert", doc_type="in")
        self._question(paper, 1)
        self.assertIn("/corpus/0500_s24_in_11.pdf", self._finished())

    def test_an_unrendered_paper_is_never_skipped(self) -> None:
        """The safety property behind the branch above.

        It admits a paper because rendering is deterministic: the renderer has
        already looked and found nothing, so a second pass finds the same
        nothing. A paper the renderer has *not* seen has page_count 0 and must
        stay pending, or it is skipped for the life of the corpus.
        """
        paper_id = self._paper("0610_s15_qp_11.pdf", "unrendered-sha")
        self.connection.execute(
            "UPDATE bank_papers SET page_count = 0 WHERE id = ?", (paper_id,))
        self.assertNotIn("/corpus/0610_s15_qp_11.pdf", self._finished())

    def test_a_paper_with_nothing_recorded_is_finished_once_rendered(self) -> None:
        """This assertion was inverted on 19 Sep, deliberately.

        It used to require that a paper with nothing recorded stay pending, but
        the fixture gives every paper a page count, so what it actually
        described was a paper the renderer had already been through and found
        nothing in. Holding those open is what stalled the run: 482 of them
        returned at the front of every chunk to be re-rendered, and nothing
        they could ever do would close them.

        The two cases are now separated. A paper with no page count is still
        pending -- test_an_unrendered_paper_is_never_skipped -- and that is the
        assertion this one was reaching for.
        """
        self._paper("empty.pdf", "f" * 64)
        self.assertIn("/corpus/empty.pdf", self._finished())


if __name__ == "__main__":
    unittest.main()


class TaggedResumeTests(TranscribedResumeTests):
    """The resume filter for a *tagging* pass.

    `transcribed()` was the right question while transcription was running and
    the wrong one the moment it finished: with 14,172 of 14,194 papers done, a
    tagging run filtered by it alone selects nothing and reports success having
    tagged nothing. The same shape as the `already_done` trap that preceded it.
    """

    def _tag_ledger(self, sha: str, root: int, status: str = "ok") -> None:
        self.connection.execute(
            "INSERT INTO bank_run_ledger (work_key, stage, source_sha256, "
            "root_number, status) VALUES (?, 'tag', ?, ?, ?)",
            (f"tag-{sha}-{root}", sha, root, status))

    def _tagged(self) -> set[str]:
        self.connection.commit()
        with mock.patch.object(corpus_run, "DB", self.db):
            return corpus_run.tagged()

    def test_a_transcribed_paper_with_no_tags_is_not_finished(self) -> None:
        paper = self._paper("untagged.pdf", "t" * 64)
        self._question(paper, 1)
        self._ledger("t" * 64, 1)
        # Transcription says done; tagging says not, and the run needs both.
        self.assertIn("/corpus/untagged.pdf", self._finished())
        self.assertNotIn("/corpus/untagged.pdf", self._tagged())

    def test_a_paper_is_tagged_once_every_question_has_a_row(self) -> None:
        paper = self._paper("tagged.pdf", "u" * 64)
        self._question(paper, 1)
        self._question(paper, 2)
        self._tag_ledger("u" * 64, 1)
        self.assertNotIn("/corpus/tagged.pdf", self._tagged())
        self._tag_ledger("u" * 64, 2)
        self.assertIn("/corpus/tagged.pdf", self._tagged())

    def test_a_mark_scheme_needs_no_tagging(self) -> None:
        """Only question papers carry topics, so a scheme is done on its own terms."""
        self._paper("scheme.pdf", "v" * 64, doc_type="ms")
        self.assertIn("/corpus/scheme.pdf", self._tagged())

    def test_a_question_paper_with_no_questions_needs_no_tagging(self) -> None:
        self._paper("empty_qp.pdf", "w" * 64)
        self.assertIn("/corpus/empty_qp.pdf", self._tagged())

    def test_a_failed_tag_does_not_count(self) -> None:
        paper = self._paper("failed_tag.pdf", "x" * 64)
        self._question(paper, 1)
        self._tag_ledger("x" * 64, 1, status="failed")
        self.assertNotIn("/corpus/failed_tag.pdf", self._tagged())
