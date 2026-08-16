"""Tests for the gold set and benchmark gate."""

from __future__ import annotations

import json
import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

from pdf_extraction.bank.gold import (
    GoldItem,
    THRESHOLD_PROSE_ACCURACY,
    THRESHOLD_FORMULA_ACCURACY,
    THRESHOLD_FIGURE_PRECISION,
    THRESHOLD_FIGURE_RECALL,
    create_sample_gold_set,
    load_gold_set,
)


class GoldSetLoadingTests(unittest.TestCase):
    def test_loads_gold_set_from_manifest(self) -> None:
        with TemporaryDirectory() as directory:
            gold_dir = Path(directory) / "gold"
            gold_dir.mkdir()

            # Create manifest
            manifest = [
                {
                    "id": "test-001",
                    "source_file": "test.pdf",
                    "doc_type": "qp",
                    "root_number": 1,
                    "metadata": {"subject": "Maths"},
                }
            ]
            (gold_dir / "manifest.json").write_text(json.dumps(manifest))
            (gold_dir / "pdfs").mkdir()

            items = load_gold_set(gold_dir)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0].id, "test-001")

    def test_fails_when_manifest_missing(self) -> None:
        with TemporaryDirectory() as directory:
            gold_dir = Path(directory) / "gold"
            gold_dir.mkdir()

            with self.assertRaises(FileNotFoundError):
                load_gold_set(gold_dir)


class BenchmarkScoringTests(unittest.TestCase):
    def test_scores_perfect_match(self) -> None:
        from pdf_extraction.bank.gold import _score_item

        gold = GoldItem(
            id="test",
            source_path="test.pdf",
            doc_type="qp",
            root_number=1,
            expected_body_md="Calculate x",
            expected_answer_md=None,
            expected_parts=[],
            expected_total_marks=5,
            expected_figures_used=["fig1"],
            expected_difficulty=3,
            metadata={},
        )

        result = {
            "body_md": "Calculate x",
            "figures_used": ["fig1"],
            "confidence": 0.9,
        }

        scores = _score_item(gold, result)
        self.assertEqual(scores["prose"], 1.0)
        self.assertEqual(scores["fig_precision"], 1.0)
        self.assertEqual(scores["fig_recall"], 1.0)
        self.assertEqual(scores["confidence"], 0.9)

    def test_scores_partial_match(self) -> None:
        from pdf_extraction.bank.gold import _score_item

        gold = GoldItem(
            id="test",
            source_path="test.pdf",
            doc_type="qp",
            root_number=1,
            expected_body_md="Calculate the value of x when f(x) = 2x + 3",
            expected_answer_md=None,
            expected_parts=[],
            expected_total_marks=5,
            expected_figures_used=["fig1", "fig2"],
            expected_difficulty=3,
            metadata={},
        )

        result = {
            "body_md": "Calculate x when f(x) = 2x + 3",  # Missing some words
            "figures_used": ["fig1"],  # Missing fig2
            "confidence": 0.8,
        }

        scores = _score_item(gold, result)
        # Character overlap should be high but < 1
        self.assertGreater(scores["prose"], 0.7)
        self.assertLess(scores["prose"], 1.0)
        # Figure recall should be 0.5 (1/2)
        self.assertEqual(scores["fig_recall"], 0.5)
        # Figure precision should be 1.0 (1/1)
        self.assertEqual(scores["fig_precision"], 1.0)

    def test_scores_zero_when_no_figures_expected(self) -> None:
        from pdf_extraction.bank.gold import _score_item

        gold = GoldItem(
            id="test",
            source_path="test.pdf",
            doc_type="qp",
            root_number=1,
            expected_body_md="State the value of x.",
            expected_answer_md=None,
            expected_parts=[],
            expected_total_marks=2,
            expected_figures_used=[],
            expected_difficulty=1,
            metadata={},
        )

        result = {
            "body_md": "State the value of x.",
            "figures_used": [],
            "confidence": 0.95,
        }

        scores = _score_item(gold, result)
        self.assertEqual(scores["fig_precision"], 1.0)  # No false positives
        self.assertEqual(scores["fig_recall"], 1.0)  # No false negatives


class SampleGoldSetTests(unittest.TestCase):
    def test_creates_sample_gold_set_structure(self) -> None:
        with TemporaryDirectory() as directory:
            create_sample_gold_set(Path(directory))

            gold_dir = Path(directory) / "gold_set"
            self.assertTrue(gold_dir.exists())
            self.assertTrue((gold_dir / "manifest.json").exists())
            self.assertTrue((gold_dir / "pdfs").is_dir())
            self.assertTrue((gold_dir / "expected").is_dir())

    def test_sample_manifest_is_valid_json(self) -> None:
        with TemporaryDirectory() as directory:
            create_sample_gold_set(Path(directory))

            manifest_path = Path(directory) / "gold_set" / "manifest.json"
            manifest = json.loads(manifest_path.read_text())

            self.assertIsInstance(manifest, list)
            self.assertGreater(len(manifest), 0)


class ThresholdTests(unittest.TestCase):
    def test_thresholds_are_reasonable(self) -> None:
        """Verify thresholds are realistic (not v3's unrealistic 0.995/1.0)."""
        self.assertLess(THRESHOLD_PROSE_ACCURACY, 1.0)
        self.assertLess(THRESHOLD_FORMULA_ACCURACY, 1.0)
        self.assertLess(THRESHOLD_FIGURE_PRECISION, 1.0)
        self.assertLess(THRESHOLD_FIGURE_RECALL, 1.0)

        # All should be >= 0.9 (high but achievable)
        self.assertGreaterEqual(THRESHOLD_PROSE_ACCURACY, 0.9)
        self.assertGreaterEqual(THRESHOLD_FORMULA_ACCURACY, 0.9)
        self.assertGreaterEqual(THRESHOLD_FIGURE_PRECISION, 0.9)
        self.assertGreaterEqual(THRESHOLD_FIGURE_RECALL, 0.9)


if __name__ == "__main__":
    unittest.main()
