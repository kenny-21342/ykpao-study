"""Tests for the stage 5 QA flags and run ledger."""

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from tempfile import TemporaryDirectory

from pdf_extraction.bank.qa import (
    ISSUE_MARKS_MISMATCH,
    ISSUE_LOW_CONFIDENCE,
    ISSUE_SUSPICIOUS_LENGTH,
    ReviewFlag,
    RunLedger,
    SEVERITY_HIGH,
    SEVERITY_LOW,
    SEVERITY_MEDIUM,
    create_ledger_key,
    run_qa_checks,
)
from pdf_extraction.bank.transcribe import QuestionTranscription


class QAChecksTests(unittest.TestCase):
    def test_passes_high_confidence_transcription(self) -> None:
        transcription = QuestionTranscription(
            root_number="5",
            body_md="Calculate the value of x.",
            parts=[{"label": "a", "marks": 3}],
            total_marks=3,
            figures_used=[],
            has_table=False,
            confidence=0.95,
            notes="",
        )
        flags = run_qa_checks(transcription, paper_id=1, question_id=10)
        self.assertEqual(len(flags), 0)

    def test_flags_low_confidence(self) -> None:
        transcription = QuestionTranscription(
            root_number="2",
            body_md="Calculate the value of x when f(x) is given.",  # Longer body to avoid length flag
            parts=[],
            total_marks=None,
            figures_used=[],
            has_table=False,
            confidence=0.4,  # Below 0.5 threshold for HIGH severity
            notes="",
        )
        flags = run_qa_checks(transcription, paper_id=1, question_id=5)
        self.assertEqual(len(flags), 1)
        self.assertEqual(flags[0].issue_type, ISSUE_LOW_CONFIDENCE)
        self.assertEqual(flags[0].severity, SEVERITY_HIGH)

    def test_flags_very_low_confidence(self) -> None:
        transcription = QuestionTranscription(
            root_number="7",
            body_md="Uncertain text.",
            parts=[],
            total_marks=None,
            figures_used=[],
            has_table=False,
            confidence=0.3,
            notes="",
        )
        flags = run_qa_checks(transcription, paper_id=1, question_id=12)
        self.assertEqual(len(flags), 1)
        self.assertEqual(flags[0].issue_type, ISSUE_LOW_CONFIDENCE)
        self.assertEqual(flags[0].severity, SEVERITY_HIGH)

    def test_flags_marks_mismatch(self) -> None:
        transcription = QuestionTranscription(
            root_number="3",
            body_md="Question with parts.",
            parts=[
                {"label": "a", "marks": 3},
                {"label": "b", "marks": 4},
            ],
            total_marks=10,  # Should be 7
            figures_used=[],
            has_table=False,
            confidence=0.8,
            notes="",
        )
        flags = run_qa_checks(transcription, paper_id=1, question_id=8)
        self.assertEqual(len(flags), 1)
        self.assertEqual(flags[0].issue_type, ISSUE_MARKS_MISMATCH)
        self.assertIn("7", flags[0].message)

    def test_flags_empty_body(self) -> None:
        transcription = QuestionTranscription(
            root_number="1",
            body_md="",
            parts=[],
            total_marks=None,
            figures_used=[],
            has_table=False,
            confidence=0.8,
            notes="",
        )
        flags = run_qa_checks(transcription, paper_id=1, question_id=1)
        self.assertEqual(len(flags), 1)
        self.assertEqual(flags[0].issue_type, ISSUE_SUSPICIOUS_LENGTH)

    def test_flags_suspiciously_short_body(self) -> None:
        transcription = QuestionTranscription(
            root_number="4",
            body_md="Hi.",  # Too short
            parts=[],
            total_marks=None,
            figures_used=[],
            has_table=False,
            confidence=0.8,
            notes="",
        )
        flags = run_qa_checks(transcription, paper_id=1, question_id=6)
        self.assertEqual(len(flags), 1)
        self.assertEqual(flags[0].issue_type, ISSUE_SUSPICIOUS_LENGTH)

    def test_multiple_flags_can_be_raised(self) -> None:
        transcription = QuestionTranscription(
            root_number="6",
            body_md="x",  # Suspiciously short
            parts=[
                {"label": "a", "marks": 2},
                {"label": "b", "marks": 3},
            ],
            total_marks=10,  # Wrong sum
            figures_used=[],
            has_table=False,
            confidence=0.4,  # Low confidence
            notes="",
        )
        flags = run_qa_checks(transcription, paper_id=1, question_id=15)
        # Should raise multiple flags: low confidence, marks mismatch, suspicious length
        self.assertGreaterEqual(len(flags), 2)
        issue_types = {flag.issue_type for flag in flags}
        self.assertIn(ISSUE_LOW_CONFIDENCE, issue_types)
        self.assertIn(ISSUE_MARKS_MISMATCH, issue_types)


class LedgerTests(unittest.TestCase):
    def test_records_successful_completion(self) -> None:
        with TemporaryDirectory() as directory:
            ledger = RunLedger(Path(directory) / "ledger.db")
            work_key = create_ledger_key("abc123", 5, "model", "v1", "transcribe")

            ledger.record_success(
                work_key=work_key,
                stage="transcribe",
                source_sha256="abc123",
                root_number=5,
                input_tokens=1000,
                output_tokens=500,
            )

            self.assertTrue(ledger.is_completed(work_key))

    def test_records_failure(self) -> None:
        with TemporaryDirectory() as directory:
            ledger = RunLedger(Path(directory) / "ledger.db")
            work_key = create_ledger_key("def456", 3, "model", "v1", "transcribe")

            ledger.record_failure(
                work_key=work_key,
                stage="transcribe",
                source_sha256="def456",
                root_number=3,
                detail="Model timeout",
            )

            self.assertFalse(ledger.is_completed(work_key))

    def test_generates_consistent_keys(self) -> None:
        key1 = create_ledger_key("abc123", 5, "model", "v1", "transcribe")
        key2 = create_ledger_key("abc123", 5, "model", "v1", "transcribe")
        key3 = create_ledger_key("abc123", 5, "model", "v2", "transcribe")  # Different prompt

        self.assertEqual(key1, key2)
        self.assertNotEqual(key1, key3)

    def test_writes_while_the_store_holds_an_open_transaction(self) -> None:
        """The ledger must share the store's connection, not compete with it.

        SQLite allows a single writer. Opening a second connection while the
        store had an uncommitted transaction raised "database is locked" on
        every ledger write, so completed questions were reported as failures.
        """
        from pdf_extraction.bank import store

        with TemporaryDirectory() as directory:
            db_path = Path(directory) / "bank.db"
            connection = store.connect(db_path)
            # Leave a write pending, exactly as process_document does.
            connection.execute(
                "INSERT INTO bank_subjects (board, code, name, level) "
                "VALUES ('CAIE', '9709', 'Maths', 'a-level')"
            )

            ledger = RunLedger(connection=connection)
            work_key = create_ledger_key("abc123", 5, "model", "v1", "transcribe")
            ledger.record_success(work_key, "transcribe", "abc123", 5, 100, 50)

            self.assertTrue(ledger.is_completed(work_key))
            connection.commit()
            connection.close()

    def test_paper_level_flags_persist_without_a_question_row(self) -> None:
        """A mark scheme's flags must still be recorded.

        Mark schemes have no question row to hang a flag from. The runner
        computed their flags and set status='needs_review', but only the
        question-paper branch wrote them, so a reviewer saw a flagged row with
        no stated reason.
        """
        from pdf_extraction.bank import ReviewFlag, store

        with TemporaryDirectory() as directory:
            connection = store.connect(Path(directory) / "bank.db")
            subject_id = store.upsert_subject(
                connection, board="CAIE", code="9709", name="Maths", level="a-level"
            )
            identity = store.PaperIdentity(
                code="9709", board="CAIE", year=2021, session="s",
                paper_number=3, variant=1, doc_type="ms",
            )
            paper_id = store.upsert_paper(
                connection, subject_id=subject_id, identity=identity,
                source_path="9709_s21_ms_31.pdf", source_sha256="abc",
                page_count=16, span_strategy="ms_table", used_ocr=False,
            )

            flag = ReviewFlag(
                question_id=None, paper_id=paper_id,
                issue_type=ISSUE_LOW_CONFIDENCE, severity=SEVERITY_MEDIUM,
                message="confidence 0.50 below threshold", evidence={"confidence": 0.5},
            )
            store.record_flags(
                connection, question_id=None, paper_id=paper_id, flags=[flag]
            )

            rows = connection.execute(
                "SELECT issue_type FROM bank_review_flags WHERE paper_id = ?",
                (paper_id,),
            ).fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["issue_type"], ISSUE_LOW_CONFIDENCE)

            # Re-processing the paper refreshes rather than duplicates.
            store.clear_paper_flags(connection, paper_id)
            store.record_flags(
                connection, question_id=None, paper_id=paper_id, flags=[flag]
            )
            count = connection.execute(
                "SELECT COUNT(*) FROM bank_review_flags WHERE paper_id = ?",
                (paper_id,),
            ).fetchone()[0]
            self.assertEqual(count, 1, "re-running must not duplicate paper flags")
            connection.close()

    def test_statistics_aggregates_correctly(self) -> None:
        with TemporaryDirectory() as directory:
            ledger = RunLedger(Path(directory) / "ledger.db")

            # Record some successes
            for i in range(3):
                work_key = create_ledger_key(f"hash{i}", i, "model", "v1", "transcribe")
                ledger.record_success(work_key, "transcribe", f"hash{i}", i, 1000, 500)

            # Record a failure
            fail_key = create_ledger_key("fail", 99, "model", "v1", "transcribe")
            ledger.record_failure(fail_key, "transcribe", "fail", 99, "Failed")

            stats = ledger.get_statistics()
            self.assertEqual(stats["total_entries"], 4)
            self.assertEqual(stats["by_status"].get("ok"), 3)
            self.assertEqual(stats["by_status"].get("failed"), 1)
            self.assertEqual(stats["total_input_tokens"], 3000)
            self.assertEqual(stats["total_output_tokens"], 1500)


if __name__ == "__main__":
    unittest.main()
