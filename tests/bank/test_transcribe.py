"""Tests for the stage 3 VLM transcription module."""

from __future__ import annotations

import unittest

from pdf_extraction.bank.transcribe import (
    MarkSchemeTranscription,
    QuestionTranscription,
    _normalize_whitespace,
    _parse_mark_scheme_response,
    _parse_question_response,
    _post_process_transcription,
)


class WhitespaceNormalizationTests(unittest.TestCase):
    def test_collapses_multiple_spaces_to_single(self) -> None:
        result = _normalize_whitespace("hello    world")
        self.assertEqual(result, "hello world")

    def test_removes_trailing_whitespace(self) -> None:
        result = _normalize_whitespace("hello   \nworld   ")
        self.assertEqual(result, "hello\nworld")

    def test_normalizes_blank_lines_to_one(self) -> None:
        result = _normalize_whitespace("hello\n\n\n\nworld")
        self.assertEqual(result, "hello\n\nworld")

    def test_removes_hyphenation_artifacts(self) -> None:
        result = _normalize_whitespace("contin-\nuation")
        self.assertEqual(result, "continuation")

    def test_recovers_latex_damaged_by_json_escaping(self) -> None:
        """Single-escaped LaTeX must survive JSON decoding.

        A model emitting "$\\frac{a}{b}$" with one backslash produces valid
        JSON whose value holds a formfeed; the normaliser then collapsed the
        tab of "\\theta" to a space, silently turning formulas into prose.
        Observed on 9709_m24_qp_32 Q11.
        """
        damaged = "Solve $(1+\text{cos }2\theta)\frac{dy}{d\theta} = 1$ now."
        recovered = _normalize_whitespace(damaged)
        self.assertIn(r"\frac", recovered)
        self.assertIn(r"\theta", recovered)
        self.assertIn(r"\text", recovered)
        self.assertNotIn("\f", recovered)
        self.assertNotIn("\t", recovered)

    def test_prose_tabs_are_not_turned_into_backslash_t(self) -> None:
        """Recovery is confined to mathematics; prose whitespace stays whitespace."""
        self.assertEqual(_normalize_whitespace("alpha\tbeta"), "alpha beta")

    def test_preserves_markdown_structure(self) -> None:
        result = _normalize_whitespace("# Header\n\nParagraph with **bold** text.")
        self.assertEqual(result, "# Header\n\nParagraph with **bold** text.")


class QuestionParsingTests(unittest.TestCase):
    def test_parses_valid_question_response(self) -> None:
        content = {
            "root_number": "5",
            "body_md": "Calculate the value of $x$ when $f(x) = 2x + 3$.",
            "parts": [{"label": "a", "marks": 3}],
            "total_marks": 3,
            "figures_used": ["fig1"],
            "has_table": False,
            "confidence": 0.92,
            "notes": "",
        }
        result = _parse_question_response(content, 5)

        self.assertEqual(result.root_number, "5")
        self.assertIn("Calculate", result.body_md)
        self.assertEqual(len(result.parts), 1)
        self.assertEqual(result.parts[0]["label"], "a")
        self.assertEqual(result.total_marks, 3)
        self.assertEqual(result.figures_used, ["fig1"])
        self.assertFalse(result.has_table)
        self.assertEqual(result.confidence, 0.92)

    def test_rejects_empty_body_md(self) -> None:
        from pdf_extraction.bank.client import ProviderError

        content = {
            "root_number": "1",
            "body_md": "",
            "parts": [],
            "total_marks": None,
            "figures_used": [],
            "has_table": False,
            "confidence": 0.5,
            "notes": "",
        }
        with self.assertRaises(ProviderError):
            _parse_question_response(content, 1)

    def test_handles_missing_optional_fields(self) -> None:
        content = {
            "root_number": "2",
            "body_md": "Question text here.",
        }
        result = _parse_question_response(content, 2)

        self.assertEqual(result.root_number, "2")
        self.assertEqual(result.parts, [])
        self.assertIsNone(result.total_marks)
        self.assertEqual(result.figures_used, [])
        self.assertFalse(result.has_table)
        self.assertEqual(result.confidence, 0.5)  # default

    def test_validates_figures_used_list(self) -> None:
        content = {
            "root_number": "3",
            "body_md": "Text with ![](asset:fig1).",
            "parts": [],
            "total_marks": 5,
            "figures_used": "not-a-list",  # Invalid type
            "has_table": False,
            "confidence": 0.8,
            "notes": "",
        }
        result = _parse_question_response(content, 3)
        # Should coerce to empty list
        self.assertEqual(result.figures_used, [])


class MarkSchemeParsingTests(unittest.TestCase):
    def test_parses_valid_mark_scheme_response(self) -> None:
        content = {
            "root_number": "7",
            "answer_md": "State the value of $x = 5$.",
            "marking_points": [
                {"mark_code": "B1", "marks": 1, "text": "Correct value stated"},
            ],
            "total_marks": 1,
            "answer_letter": None,
            "confidence": 0.88,
            "notes": "",
        }
        result = _parse_mark_scheme_response(content, 7)

        self.assertEqual(result.root_number, "7")
        self.assertIn("State the value", result.answer_md)
        self.assertEqual(len(result.marking_points), 1)
        self.assertEqual(result.marking_points[0]["mark_code"], "B1")
        self.assertEqual(result.total_marks, 1)
        self.assertIsNone(result.answer_letter)
        self.assertEqual(result.confidence, 0.88)

    def test_parses_mcq_mark_scheme(self) -> None:
        content = {
            "root_number": "12",
            "answer_md": "A",
            "marking_points": [],
            "total_marks": 1,
            "answer_letter": "A",
            "confidence": 0.99,
            "notes": "",
        }
        result = _parse_mark_scheme_response(content, 12)

        self.assertEqual(result.answer_letter, "A")
        self.assertEqual(result.total_marks, 1)

    def test_handles_malformed_marking_points(self) -> None:
        content = {
            "root_number": "3",
            "answer_md": "Answer text.",
            "marking_points": [
                {"mark_code": "M1", "marks": 2, "text": "Method"},
                "not-a-dict",  # Should be filtered (not a dict)
                {"mark_code": "A1", "marks": "invalid", "text": "Answer"},  # Should be filtered (invalid marks)
            ],
            "total_marks": None,
            "answer_letter": None,
            "confidence": 0.7,
            "notes": "",
        }
        parsed = _parse_mark_scheme_response(content, 3)
        # Post-process to apply validation
        result = _post_process_transcription(parsed)

        # Should only include entries that are dicts with valid mark codes and numeric marks
        self.assertEqual(len(result.marking_points), 1)
        self.assertEqual(result.marking_points[0]["mark_code"], "M1")
        self.assertEqual(result.marking_points[0]["marks"], 2)


if __name__ == "__main__":
    unittest.main()
