"""Stage 4's topics have to reach the database.

`bank_topics` and `bank_question_topics` are in the schema, `merge_to_neon`
copies them, and the app filters mock exams by them -- but `upsert_question`
only ever called `_link_tags`. Nothing wrote a topic row, so both tables were
empty across all 85,611 questions and the mock-exam Topics control is hidden
for want of data. Tags were linked right next door, which is why a tagging run
looked like it was working.
"""

from __future__ import annotations

import sqlite3
import unittest
from dataclasses import dataclass

from pdf_extraction.bank import store
from pdf_extraction.bank.renderer import RenderedSpan
from pdf_extraction.bank.store import PaperIdentity
from pdf_extraction.bank.transcribe import QuestionTranscription


@dataclass(frozen=True)
class FakeTagging:
    topics: list[str]
    tags: list[str]
    confidence: float = 0.9
    difficulty: int | None = 3
    difficulty_rationale: str = ""


def _transcription(root: str = "1") -> QuestionTranscription:
    return QuestionTranscription(
        root_number=root, body_md="Find the vector.", parts=[], total_marks=3,
        figures_used=[], has_table=False, confidence=0.9, notes="",
    )


class TopicLinkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(store.SCHEMA_PATH.read_text(encoding="utf-8"))
        self.subject_id = store.upsert_subject(
            self.connection, board="CAIE", code="9709", name="Mathematics", level="a-level"
        )
        self.paper_id = self._paper(1, "a")
        self.other_paper_id = self._paper(2, "b")

    def tearDown(self) -> None:
        self.connection.close()

    def _paper(self, number: int, seed: str) -> int:
        return store.upsert_paper(
            self.connection,
            subject_id=self.subject_id,
            identity=PaperIdentity(
                code="9709", board="CAIE", year=2017, session="s",
                paper_number=number, variant=1, doc_type="qp",
            ),
            source_path=f"/tmp/9709_s17_qp_{number}1.pdf", source_sha256=seed * 64,
            page_count=1, span_strategy="prose", used_ocr=False,
        )

    def _store(self, paper_id: int, tagging, root: str = "1") -> int:
        return store.upsert_question(
            self.connection, paper_id=paper_id, transcription=_transcription(root),
            rendered_span=RenderedSpan(root_number=int(root), strips=()),
            asset_ids={}, tagging=tagging, run_id="r", model="m",
            prompt_version="p", status="published",
        )

    def _topics_of(self, question_id: int) -> list[str]:
        return [row["name"] for row in self.connection.execute(
            "SELECT t.name FROM bank_topics t "
            "JOIN bank_question_topics qt ON qt.topic_id = t.id "
            "WHERE qt.question_id = ? ORDER BY t.name", (question_id,))]

    def test_topics_are_written(self) -> None:
        question_id = self._store(self.paper_id, FakeTagging(["Vectors", "Series"], []))
        self.assertEqual(self._topics_of(question_id), ["Series", "Vectors"])

    def test_a_topic_is_shared_across_papers_of_one_subject(self) -> None:
        """Filtering by "Vectors" is only useful if it means one thing."""
        first = self._store(self.paper_id, FakeTagging(["Vectors"], []))
        second = self._store(self.other_paper_id, FakeTagging(["Vectors"], []))
        self.assertNotEqual(first, second)
        self.assertEqual(
            self.connection.execute("SELECT count(*) FROM bank_topics").fetchone()[0], 1)

    def test_re_tagging_replaces_rather_than_accumulates(self) -> None:
        self._store(self.paper_id, FakeTagging(["Vectors"], []))
        question_id = self._store(self.paper_id, FakeTagging(["Series"], []))
        self.assertEqual(self._topics_of(question_id), ["Series"])

    def test_blank_and_missing_topics_are_ignored(self) -> None:
        question_id = self._store(self.paper_id, FakeTagging(["  ", ""], ["a-tag"]))
        self.assertEqual(self._topics_of(question_id), [])
        # The tag beside it still lands, which is what made this invisible.
        self.assertEqual(
            self.connection.execute(
                "SELECT count(*) FROM bank_question_tags WHERE question_id = ?",
                (question_id,)).fetchone()[0], 1)

    def test_an_untagged_question_writes_no_topics(self) -> None:
        question_id = self._store(self.paper_id, None)
        self.assertEqual(self._topics_of(question_id), [])


if __name__ == "__main__":
    unittest.main()
