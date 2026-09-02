"""Stage 4's command words have to reach the database too.

`tag.py` has produced `skills` for every question it has ever tagged --
deterministically, from the text -- and `store.py` wrote difficulty, tags and
topics and dropped the skills on the floor. There was no table to put them in.

The same failure as topics, one column over: the tagging run looked like it was
working because the rows beside it landed.
"""

from __future__ import annotations

import sqlite3
import unittest
from dataclasses import dataclass, field

from pdf_extraction.bank import store
from pdf_extraction.bank.renderer import RenderedSpan
from pdf_extraction.bank.store import PaperIdentity
from pdf_extraction.bank.tag import extract_command_words
from pdf_extraction.bank.transcribe import QuestionTranscription


@dataclass(frozen=True)
class FakeTagging:
    topics: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    confidence: float = 0.9
    difficulty: int | None = 3
    difficulty_rationale: str = ""


def _transcription(root: str = "1") -> QuestionTranscription:
    return QuestionTranscription(
        root_number=root, body_md="Calculate the vector.", parts=[], total_marks=3,
        figures_used=[], has_table=False, confidence=0.9, notes="",
    )


class SkillLinkTests(unittest.TestCase):
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

    def _skills_of(self, question_id: int) -> list[str]:
        return [row["slug"] for row in self.connection.execute(
            "SELECT s.slug FROM bank_skills s "
            "JOIN bank_question_skills qs ON qs.skill_id = s.id "
            "WHERE qs.question_id = ? ORDER BY s.slug", (question_id,))]

    def test_skills_are_written(self) -> None:
        question_id = self._store(self.paper_id, FakeTagging(skills=["calculate", "explain"]))
        self.assertEqual(self._skills_of(question_id), ["calculate", "explain"])

    def test_a_skill_is_shared_across_papers(self) -> None:
        """Per-term accuracy is only meaningful if "explain" is one row."""
        first = self._store(self.paper_id, FakeTagging(skills=["explain"]))
        second = self._store(self.other_paper_id, FakeTagging(skills=["explain"]))
        self.assertNotEqual(first, second)
        self.assertEqual(
            self.connection.execute("SELECT count(*) FROM bank_skills").fetchone()[0], 1)

    def test_re_tagging_replaces_rather_than_accumulates(self) -> None:
        self._store(self.paper_id, FakeTagging(skills=["state"]))
        question_id = self._store(self.paper_id, FakeTagging(skills=["prove"]))
        self.assertEqual(self._skills_of(question_id), ["prove"])

    def test_case_and_blanks_are_normalised_away(self) -> None:
        question_id = self._store(self.paper_id, FakeTagging(skills=["  Explain ", "", "  "]))
        self.assertEqual(self._skills_of(question_id), ["explain"])

    def test_an_untagged_question_writes_no_skills(self) -> None:
        question_id = self._store(self.paper_id, None)
        self.assertEqual(self._skills_of(question_id), [])

    def test_a_tagging_without_a_skills_field_is_tolerated(self) -> None:
        """Older TaggingResult-shaped objects must not break a tagging run."""

        @dataclass(frozen=True)
        class LegacyTagging:
            topics: list[str] = field(default_factory=list)
            tags: list[str] = field(default_factory=list)
            confidence: float = 0.9
            difficulty: int | None = 3
            difficulty_rationale: str = ""

        question_id = self._store(self.paper_id, LegacyTagging(tags=["vectors"]))
        self.assertEqual(self._skills_of(question_id), [])

    def test_skills_do_not_leak_into_the_search_tag_vocabulary(self) -> None:
        """The whole reason for a separate table."""
        self._store(self.paper_id, FakeTagging(tags=["vectors"], skills=["calculate"]))
        tags = [row["slug"] for row in self.connection.execute("SELECT slug FROM bank_tags")]
        self.assertEqual(tags, ["vectors"])

    def test_the_deterministic_extractor_feeds_straight_in(self) -> None:
        """No model call is needed to fill this table, which is the point."""
        skills = extract_command_words("Calculate the speed, then explain the difference.")
        question_id = self._store(self.paper_id, FakeTagging(skills=skills))
        self.assertEqual(self._skills_of(question_id), ["calculate", "explain"])


if __name__ == "__main__":
    unittest.main()
