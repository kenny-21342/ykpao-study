"""Tests for the stage 4 tagging and difficulty module."""

from __future__ import annotations

import unittest

from pdf_extraction.bank.tag import (
    COMMAND_WORDS,
    TaggingResult,
    _build_tagging_prompt,
    extract_command_words,
)


class CommandWordsTests(unittest.TestCase):
    def test_extracts_single_command_word(self) -> None:
        result = extract_command_words("Calculate the value of x.")
        self.assertEqual(result, ["calculate"])

    def test_extracts_multiple_command_words(self) -> None:
        result = extract_command_words("State the value of x and then calculate y.")
        self.assertIn("state", result)
        self.assertIn("calculate", result)
        self.assertEqual(len(result), 2)

    def test_handles_case_insensitive(self) -> None:
        result = extract_command_words("CALCULATE the answer.")
        self.assertEqual(result, ["calculate"])

    def test_returns_empty_when_no_commands_found(self) -> None:
        result = extract_command_words("The quick brown fox jumps over the lazy dog.")
        self.assertEqual(result, [])

    def test_preserves_order_of_first_appearance(self) -> None:
        result = extract_command_words("Find x, then calculate y, and finally show your working.")
        self.assertEqual(result, ["find", "calculate", "show"])

    def test_no_duplicate_commands(self) -> None:
        result = extract_command_words("Calculate x, then calculate y.")
        self.assertEqual(result, ["calculate"])


class PromptBuildingTests(unittest.TestCase):
    def test_includes_question_text(self) -> None:
        prompt = _build_tagging_prompt("Solve 2x + 3 = 11", None, None)
        self.assertIn("Solve 2x + 3 = 11", prompt)

    def test_includes_difficulty_rubric(self) -> None:
        prompt = _build_tagging_prompt("Question text", None, None)
        self.assertIn("DIFFICULTY RUBRIC", prompt)
        # All five levels must be described, or ratings are not comparable
        # across subjects.
        for level in range(1, 6):
            self.assertIn(f"{level} —", prompt)

    def test_includes_subject_context(self) -> None:
        prompt = _build_tagging_prompt("Question", None, "A-Level Maths")
        self.assertIn("A-Level Maths", prompt)

    def test_includes_syllabus_topics_when_provided(self) -> None:
        topics = ["Algebra", "Calculus", "Trigonometry"]
        prompt = _build_tagging_prompt("Question", topics, None)
        self.assertIn("syllabus_topics", prompt)
        for topic in topics:
            self.assertIn(topic, prompt)

    def test_includes_json_format_instructions(self) -> None:
        prompt = _build_tagging_prompt("Question", None, None)
        self.assertIn("Return exactly this shape", prompt)
        self.assertIn('"topics"', prompt)
        self.assertIn('"difficulty"', prompt)


class TaggingResultTests(unittest.TestCase):
    def test_serializes_to_dict_correctly(self) -> None:
        result = TaggingResult(
            topics=["topic1", "topic2"],
            tags=["integration", "by-parts"],
            skills=["calculate", "substitute"],
            difficulty=4,
            difficulty_rationale="Requires integration by parts and substitution",
            confidence=0.85,
        )
        data = result.to_dict()

        self.assertEqual(data["topics"], ["topic1", "topic2"])
        self.assertEqual(data["tags"], ["integration", "by-parts"])
        self.assertEqual(data["skills"], ["calculate", "substitute"])
        self.assertEqual(data["difficulty"], 4)
        self.assertIn("integration by parts", data["difficulty_rationale"])
        self.assertEqual(data["confidence"], 0.85)

    def test_handles_empty_lists(self) -> None:
        result = TaggingResult(
            topics=[],
            tags=[],
            skills=[],
            difficulty=2,
            difficulty_rationale="Simple calculation",
            confidence=0.9,
        )
        data = result.to_dict()

        self.assertEqual(data["topics"], [])
        self.assertEqual(data["tags"], [])
        self.assertEqual(data["skills"], [])


class CommandWordsVocabularyTests(unittest.TestCase):
    def test_common_maths_commands(self) -> None:
        self.assertIn("calculate", COMMAND_WORDS)
        self.assertIn("solve", COMMAND_WORDS)
        self.assertIn("prove", COMMAND_WORDS)

    def test_common_physics_commands(self) -> None:
        self.assertIn("state", COMMAND_WORDS)
        self.assertIn("determine", COMMAND_WORDS)
        self.assertIn("explain", COMMAND_WORDS)

    def test_difficulty_varies_by_command(self) -> None:
        # Low difficulty
        self.assertIn("state", COMMAND_WORDS)
        self.assertIn("write", COMMAND_WORDS)
        # High difficulty
        self.assertIn("prove", COMMAND_WORDS)
        self.assertIn("derive", COMMAND_WORDS)


if __name__ == "__main__":
    unittest.main()
