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

    def _ledger(self, sha: str, root: int, status: str = "ok") -> None:
        self.connection.execute(
            "INSERT INTO bank_run_ledger (work_key, stage, source_sha256, "
            "root_number, status) VALUES (?, 'transcribe', ?, ?, ?)",
            (f"{sha}-{root}", sha, root, status))

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

    def test_a_failed_entry_does_not_count_as_transcribed(self) -> None:
        paper = self._paper("failed.pdf", "c" * 64)
        self._question(paper, 1)
        self._ledger("c" * 64, 1, status="failed")
        self.assertNotIn("/corpus/failed.pdf", self._finished())

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
