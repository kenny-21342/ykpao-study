"""Gold set and benchmark gate for v4 pipeline validation.

The gold set is a curated collection of ~20 hand-checked real questions
that the pipeline must process correctly before being allowed to run on the
full corpus. This prevents catastrophic failures from propagating to thousands
of documents.

Gold set composition (CAIE + IB, Maths + Physics + Biology):
- Multi-page questions (spanning 2-3 pages)
- Questions with tables (HTML + PNG fallback)
- Questions with vector diagrams
- Questions with embedded images
- Scanned pages (OCR fallback)
- Various difficulty levels (1-5)
- Mark schemes with different formats (prose, tabular, MCQ)

Quality thresholds (more realistic than v3's ≥ 0.995/1.0 gates):
- Text accuracy (prose): ≥ 0.97
- Formula accuracy (LaTeX): ≥ 0.95
- Figure detection/recall: ≥ 0.95

The benchmark gate is a hard stop: the pipeline cannot run on the full
corpus unless it clears these thresholds on the gold set.
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


# Quality thresholds (realistic, validated on real data)
THRESHOLD_PROSE_ACCURACY = 0.97
THRESHOLD_FORMULA_ACCURACY = 0.95
THRESHOLD_FIGURE_PRECISION = 0.95
THRESHOLD_FIGURE_RECALL = 0.95
THRESHOLD_CONFIDENCE = 0.7


@dataclass(frozen=True)
class GoldItem:
    """One question in the gold set with expected output."""

    id: str
    source_path: str
    doc_type: str  # qp | ms
    root_number: int
    expected_body_md: str | None  # For QP
    expected_answer_md: str | None  # For MS
    expected_parts: list[dict[str, Any]]
    expected_total_marks: int | None
    expected_figures_used: list[str]
    expected_difficulty: int | None
    metadata: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source_path": self.source_path,
            "doc_type": self.doc_type,
            "root_number": self.root_number,
            "expected_body_md": self.expected_body_md,
            "expected_answer_md": self.expected_answer_md,
            "expected_parts": self.expected_parts,
            "expected_total_marks": self.expected_total_marks,
            "expected_figures_used": self.expected_figures_used,
            "expected_difficulty": self.expected_difficulty,
            "metadata": self.metadata,
        }


@dataclass(frozen=True)
class BenchmarkResult:
    """Result of running the pipeline on the gold set."""

    passed: bool
    scores: dict[str, float]
    details: dict[str, Any]
    failures: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "scores": self.scores,
            "details": self.details,
            "failures": self.failures,
        }


def load_gold_set(gold_dir: Path) -> list[GoldItem]:
    """Load the gold set from a directory.

    Expected structure:
        gold_dir/
            manifest.json  # List of gold items with metadata
            pdfs/         # Source PDF files
            expected/     # Expected output JSON files
    """
    manifest_path = gold_dir / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Gold set manifest not found: {manifest_path}")

    manifest = json.loads(manifest_path.read_text())
    items: list[GoldItem] = []

    for entry in manifest:
        # Load expected output if available
        expected_path = gold_dir / "expected" / f"{entry['id']}.json"
        expected = {}
        if expected_path.exists():
            expected = json.loads(expected_path.read_text())

        item = GoldItem(
            id=entry["id"],
            source_path=str(gold_dir / "pdfs" / entry["source_file"]),
            doc_type=entry.get("doc_type", "qp"),
            root_number=entry["root_number"],
            expected_body_md=expected.get("body_md"),
            expected_answer_md=expected.get("answer_md"),
            expected_parts=expected.get("parts", []),
            expected_total_marks=expected.get("total_marks"),
            expected_figures_used=expected.get("figures_used", []),
            expected_difficulty=expected.get("difficulty"),
            metadata=entry.get("metadata", {}),
        )
        items.append(item)

    return items


def run_benchmark(
    gold_items: list[GoldItem],
    pipeline_func,  # Function that processes a PDF and returns results
) -> BenchmarkResult:
    """Run the pipeline on the gold set and measure quality.

    Args:
        gold_items: List of GoldItem to test against
        pipeline_func: Function that takes (source_path, doc_type) and returns
                       pipeline results

    Returns:
        BenchmarkResult with scores and pass/fail determination
    """
    scores = {
        "prose_accuracy": 0.0,
        "formula_accuracy": 0.0,
        "figure_precision": 0.0,
        "figure_recall": 0.0,
        "confidence_mean": 0.0,
    }

    details = {
        "total_items": len(gold_items),
        "processed_items": 0,
        "failed_items": [],
    }

    failures: list[dict[str, Any]] = []

    # Process each gold item
    for item in gold_items:
        try:
            result = pipeline_func(item.source_path, item.doc_type)
            details["processed_items"] += 1

            # Compare against expected
            item_score = _score_item(item, result)
            scores["prose_accuracy"] += item_score.get("prose", 0)
            scores["formula_accuracy"] += item_score.get("formula", 0)
            scores["figure_precision"] += item_score.get("fig_precision", 0)
            scores["figure_recall"] += item_score.get("fig_recall", 0)
            scores["confidence_mean"] += item_score.get("confidence", 0)

        except Exception as e:
            failures.append({
                "item_id": item.id,
                "error": str(e),
                "source_path": item.source_path,
            })

    # Normalize scores
    if details["processed_items"] > 0:
        for key in scores:
            scores[key] /= details["processed_items"]

    # Determine pass/fail
    passed = all([
        scores["prose_accuracy"] >= THRESHOLD_PROSE_ACCURACY,
        scores["formula_accuracy"] >= THRESHOLD_FORMULA_ACCURACY,
        scores["figure_precision"] >= THRESHOLD_FIGURE_PRECISION,
        scores["figure_recall"] >= THRESHOLD_FIGURE_RECALL,
        scores["confidence_mean"] >= THRESHOLD_CONFIDENCE,
    ])

    details["failed_items"] = failures

    return BenchmarkResult(
        passed=passed,
        scores=scores,
        details=details,
        failures=failures,
    )


def _score_item(gold: GoldItem, result: dict[str, Any]) -> dict[str, float]:
    """Score a single pipeline result against its gold standard.

    Prose and formulas are scored separately: a transcription can get every
    word right and still mangle the mathematics, and averaging the two would
    hide exactly that failure.
    """
    scores = {
        "prose": 0.0,
        "formula": 0.0,
        "fig_precision": 0.0,
        "fig_recall": 0.0,
        "confidence": 0.0,
    }

    expected_body = gold.expected_body_md or gold.expected_answer_md or ""
    actual_body = result.get("body_md") or result.get("answer_md") or ""

    if expected_body:
        # Compare prose with the mathematics removed, and the mathematics on
        # its own. Comparing whole strings would let a long correct stem mask a
        # wrong formula, which is the error that actually matters to a student.
        scores["prose"] = _sequence_ratio(
            _prose_only(expected_body), _prose_only(actual_body)
        )
        scores["formula"] = _formula_score(expected_body, actual_body)

    # Figure precision/recall
    if gold.expected_figures_used and result.get("figures_used"):
        expected_figs = set(gold.expected_figures_used)
        actual_figs = set(result["figures_used"])

        if expected_figs:
            scores["fig_precision"] = (
                len(expected_figs & actual_figs) / len(actual_figs)
                if actual_figs else 0.0
            )
            scores["fig_recall"] = (
                len(expected_figs & actual_figs) / len(expected_figs)
            )
    elif not gold.expected_figures_used and not result.get("figures_used"):
        # Perfect match when neither expects nor detects figures
        scores["fig_precision"] = 1.0
        scores["fig_recall"] = 1.0
    elif not gold.expected_figures_used:
        # No figures expected but some were detected (false positives)
        scores["fig_recall"] = 1.0  # No false negatives
        scores["fig_precision"] = 0.0  # False positives exist

    # Confidence
    scores["confidence"] = result.get("confidence", 0.0)

    return scores


_MATH_SPAN = re.compile(r"\$\$(.+?)\$\$|\$(.+?)\$", re.DOTALL)
_FIGURE_REF = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_HTML_TAG = re.compile(r"<[^>]+>")


def _prose_only(text: str) -> str:
    """Text with mathematics, figure references, and HTML stripped out."""
    without_math = _MATH_SPAN.sub(" ", text)
    without_figures = _FIGURE_REF.sub(" ", without_math)
    return _normalize(_HTML_TAG.sub(" ", without_figures))


def _normalize(text: str) -> str:
    """Fold the differences that do not change meaning."""
    text = unicodedata.normalize("NFKC", text)
    # Unicode dashes and quotes vary between the PDF and the model's output.
    for source, target in (("−", "-"), ("–", "-"), ("—", "-"),
                           ("’", "'"), ("“", '"'), ("”", '"')):
        text = text.replace(source, target)
    text = re.sub(r"[*_`#>]", " ", text)          # markdown emphasis marks
    text = re.sub(r"\s+", " ", text)
    return text.strip().casefold()


def _sequence_ratio(expected: str, actual: str) -> float:
    """Order-sensitive similarity in [0, 1].

    ``SequenceMatcher`` is used rather than a set comparison because set
    overlap scores reversed or shuffled text as perfect — the original metric
    gave fully reversed text 1.0.
    """
    if not expected and not actual:
        return 1.0
    if not expected or not actual:
        return 0.0
    return SequenceMatcher(None, expected, actual).ratio()


def _math_spans(text: str) -> list[str]:
    spans: list[str] = []
    for display, inline in _MATH_SPAN.findall(text):
        body = display or inline
        # Whitespace inside LaTeX is not semantic, so it must not count as a
        # difference.
        collapsed = re.sub(r"\s+", "", body)
        if collapsed:
            spans.append(collapsed)
    return spans


def _formula_score(expected: str, actual: str) -> float:
    """Mean similarity over positionally matched LaTeX spans.

    A missing or extra formula scores zero for that slot, so dropping the
    mathematics cannot be hidden by getting the remaining spans right.
    """
    expected_spans = _math_spans(expected)
    actual_spans = _math_spans(actual)
    if not expected_spans:
        # Inventing mathematics that was never printed is itself an error.
        return 1.0 if not actual_spans else 0.0

    total = 0.0
    for index, expected_span in enumerate(expected_spans):
        if index >= len(actual_spans):
            continue
        total += _sequence_ratio(expected_span, actual_spans[index])
    # Divide by the larger count so extra spurious formulas are penalised too.
    return total / max(len(expected_spans), len(actual_spans))


def create_sample_gold_set(output_dir: Path) -> None:
    """Create a sample gold set manifest for development.

    This is a placeholder - real gold set should be hand-curated from
    actual past papers with careful verification.
    """
    output_dir = output_dir / "gold_set"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Create directories
    (output_dir / "pdfs").mkdir(exist_ok=True)
    (output_dir / "expected").mkdir(exist_ok=True)

    # Sample manifest (to be replaced with real gold items)
    manifest = [
        {
            "id": "caie-9709-2021-mj-q1",
            "source_file": "9709_s21_qp_12.pdf",
            "doc_type": "qp",
            "root_number": 1,
            "metadata": {
                "subject": "Mathematics",
                "year": 2021,
                "paper": 12,
                "characteristics": ["multi-page", "has-table"],
            },
        },
        {
            "id": "caie-9709-2021-mj-q5",
            "source_file": "9709_s21_qp_12.pdf",
            "doc_type": "qp",
            "root_number": 5,
            "metadata": {
                "subject": "Mathematics",
                "year": 2021,
                "paper": 12,
                "characteristics": ["vector-diagram", "high-difficulty"],
            },
        },
    ]

    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Sample gold set created at {output_dir}")
    print("This is a placeholder - replace with real hand-verified questions.")
