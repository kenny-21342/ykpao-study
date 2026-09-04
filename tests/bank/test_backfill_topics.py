"""The topic backfill's write path, and the guard that it stays whitelisted.

The script itself is mostly file I/O over PDFs that are not in the repo, so
what is tested here is the part with logic: linking a question to topics scoped
to its subject, and refusing to invent a topic the syllabus does not list.
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "backfill_topics_from_pdf", ROOT / "scripts" / "backfill_topics_from_pdf.py"
)
assert _spec and _spec.loader
backfill = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(backfill)

from pdf_extraction.bank.tag import _parse_tagging_response  # noqa: E402


def _store() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        CREATE TABLE bank_subjects (id INTEGER PRIMARY KEY, code TEXT);
        CREATE TABLE bank_papers (
            id INTEGER PRIMARY KEY, subject_id INTEGER, source_path TEXT,
            doc_type TEXT DEFAULT 'qp');
        CREATE TABLE bank_questions (id INTEGER PRIMARY KEY);
        INSERT INTO bank_subjects (id, code) VALUES (1, '0625'), (2, '0610');
        INSERT INTO bank_papers (id, subject_id, source_path)
            VALUES (1, 1, '/p/physics.pdf'), (2, 2, '/p/biology.pdf');
        INSERT INTO bank_questions (id) VALUES (10), (11);
        """
    )
    backfill.ensure_schema(connection)
    return connection


class WriteTopicsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = _store()
        self.addCleanup(self.connection.close)

    def names_for(self, question_id: int) -> list[str]:
        return [
            row[0]
            for row in self.connection.execute(
                "SELECT t.name FROM bank_question_topics qt "
                "JOIN bank_topics t ON t.id = qt.topic_id "
                "WHERE qt.question_id = ? ORDER BY t.name",
                (question_id,),
            )
        ]

    def test_links_a_question_to_its_topics(self) -> None:
        backfill.write_topics(self.connection, 1, 10, ["Waves", "Thermal physics"])
        self.assertEqual(self.names_for(10), ["Thermal physics", "Waves"])

    def test_a_topic_is_created_once_and_reused_across_questions(self) -> None:
        """Topics are per subject, which is what makes filtering by one useful."""
        backfill.write_topics(self.connection, 1, 10, ["Waves"])
        backfill.write_topics(self.connection, 1, 11, ["Waves"])
        rows = self.connection.execute(
            "SELECT COUNT(*) FROM bank_topics WHERE name = 'Waves'"
        ).fetchone()[0]
        self.assertEqual(rows, 1)

    def test_the_same_name_under_two_subjects_is_two_topics(self) -> None:
        """"Waves" in Physics is not "Waves" in Biology; mastery must not merge."""
        backfill.write_topics(self.connection, 1, 10, ["Waves"])
        backfill.write_topics(self.connection, 2, 11, ["Waves"])
        rows = self.connection.execute(
            "SELECT COUNT(*) FROM bank_topics WHERE name = 'Waves'"
        ).fetchone()[0]
        self.assertEqual(rows, 2)

    def test_rewriting_a_question_replaces_rather_than_accumulates(self) -> None:
        """--refresh must not leave the previous run's topics behind."""
        backfill.write_topics(self.connection, 1, 10, ["Waves", "Electricity and magnetism"])
        backfill.write_topics(self.connection, 1, 10, ["Waves"])
        self.assertEqual(self.names_for(10), ["Waves"])

    def test_blank_and_whitespace_names_are_dropped(self) -> None:
        backfill.write_topics(self.connection, 1, 10, ["Waves", "", "   "])
        self.assertEqual(self.names_for(10), ["Waves"])

    def test_a_repeated_name_links_once(self) -> None:
        backfill.write_topics(self.connection, 1, 10, ["Waves", "Waves"])
        self.assertEqual(self.names_for(10), ["Waves"])

    def test_ensure_schema_is_idempotent(self) -> None:
        backfill.write_topics(self.connection, 1, 10, ["Waves"])
        backfill.ensure_schema(self.connection)
        self.assertEqual(self.names_for(10), ["Waves"])


class ResumeTests(unittest.TestCase):
    def test_already_tagged_reports_only_questions_carrying_a_topic(self) -> None:
        connection = _store()
        self.addCleanup(connection.close)
        self.assertEqual(backfill.already_tagged(connection), set())
        backfill.write_topics(connection, 1, 10, ["Waves"])
        self.assertEqual(backfill.already_tagged(connection), {10})

    def test_a_store_without_the_tables_resumes_from_nothing(self) -> None:
        """The store predates these tables; a dry run must not crash on it."""
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        self.assertEqual(backfill.already_tagged(connection), set())


class WhitelistTests(unittest.TestCase):
    """The backfill spends money per question, so the whitelist has to hold."""

    def test_a_topic_outside_the_syllabus_is_discarded(self) -> None:
        reply = {"topics": ["Astrology"], "tags": [], "skills": [],
                 "difficulty": 3, "difficulty_rationale": "", "confidence": 0.9}
        result = _parse_tagging_response(
            reply, allowed_topics=["Waves"], source_text="Describe the wave.")
        self.assertEqual(result.topics, [])

    def test_the_minimum_length_excludes_a_rubric_line(self) -> None:
        """Under this, the slice is a page number and a rubric, not a question."""
        self.assertGreater(backfill.MIN_CHARS, len("Answer all questions."))


if __name__ == "__main__":
    unittest.main()
