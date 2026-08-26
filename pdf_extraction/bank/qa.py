"""Stage 5 — QA flags, review queue, and run ledger.

This stage implements advisory QA checks that never block writes but route
questionable content to a review queue. Every question is written; checks only
affect its status field.

QA checks include:
- Parts marks don't sum to total_marks
- LaTeX spans fail KaTeX compilation
- body_md references an asset id not in the inventory
- Root numbers have gaps within a paper
- Model confidence below threshold
- No mark scheme paired (soft - resource booklets legitimately have none)
- Body suspiciously short relative to span height
- The crop itself: does it start at the question number, does it still show
  the marks, is page furniture visible, did an erase box eat real words

The crop checks run in phase A, on geometry alone, because in crop-first mode
the image *is* the product and there may be no transcription to check at all.

The run ledger enables resumable long runs by recording which work items
completed successfully. Keyed on (source_sha256 + span + model + prompt version).
"""
from __future__ import annotations

import json
import re

from . import erase_guard
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence


# QA check types
ISSUE_MARKS_MISMATCH = "marks_mismatch"
ISSUE_LATEX_INVALID = "latex_invalid"
ISSUE_ASSET_REFERENCE = "asset_reference"
ISSUE_NUMBERING_GAP = "numbering_gap"
ISSUE_LOW_CONFIDENCE = "low_confidence"
ISSUE_MISSING_MARK_SCHEME = "missing_mark_scheme"
ISSUE_SUSPICIOUS_LENGTH = "suspicious_length"
ISSUE_FIGURE_UNCITED = "figure_uncited"
ISSUE_FIGURE_CITATION_OFFSET = "figure_citation_offset"
ISSUE_FIGURE_CITATION_ORDER = "figure_citation_order"
ISSUE_CROP_MISSING_NUMBER = "crop_missing_number"
ISSUE_CROP_NO_MARKS = "crop_no_marks"
ISSUE_CROP_FURNITURE = "crop_furniture"
ISSUE_CROP_ERASED_TEXT = "crop_erased_text"
ISSUE_CROP_EMPTY = "crop_empty"

# Severity levels
SEVERITY_LOW = "low"
SEVERITY_MEDIUM = "medium"
SEVERITY_HIGH = "high"

# Status values
STATUS_OPEN = "open"
STATUS_RESOLVED = "resolved"
STATUS_DISMISSED = "dismissed"


# Confidence thresholds
DEFAULT_CONFIDENCE_THRESHOLD = 0.7
HIGH_CONFIDENCE_THRESHOLD = 0.9


@dataclass(frozen=True)
class ReviewFlag:
    """A QA issue requiring human review."""

    question_id: int | None
    paper_id: int | None
    issue_type: str
    severity: str
    message: str
    evidence: dict[str, Any] | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "question_id": self.question_id,
            "paper_id": self.paper_id,
            "issue_type": self.issue_type,
            "severity": self.severity,
            "message": self.message,
            "evidence": self.evidence,
        }


@dataclass(frozen=True)
class LedgerEntry:
    """A completed work item in the run ledger."""

    work_key: str  # sha256(source + span + model + prompt)
    stage: str  # transcribe | tag
    source_sha256: str
    root_number: int | None
    status: str  # ok | failed
    detail: str | None
    input_tokens: int
    output_tokens: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "work_key": self.work_key,
            "stage": self.stage,
            "source_sha256": self.source_sha256,
            "root_number": self.root_number,
            "status": self.status,
            "detail": self.detail,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
        }


def run_qa_checks(
    transcription,
    paper_id: int | None,
    question_id: int | None,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
    figure_inventory: Sequence[Mapping[str, Any]] | None = None,
) -> list[ReviewFlag]:
    """Run all QA checks on a transcription and return any flags.

    Args:
        transcription: QuestionTranscription or MarkSchemeTranscription
        paper_id: Database paper_id for this question
        question_id: Database question_id (None for MS-only checks)
        confidence_threshold: Minimum acceptable confidence
        figure_inventory: the rendered span's figures, in the order they were
            offered to the model. Omitted, the figure checks are skipped —
            they cannot say anything useful without knowing what was on offer.

    Returns:
        List of ReviewFlag objects (empty if no issues)
    """
    flags: list[ReviewFlag] = []

    # Check confidence
    flags.extend(_check_confidence(transcription, paper_id, question_id, confidence_threshold))

    # Check parts marks sum (questions only)
    if hasattr(transcription, "parts") and hasattr(transcription, "total_marks"):
        flags.extend(_check_parts_sum(transcription, paper_id, question_id))

    # Check for suspiciously short body (questions only)
    if hasattr(transcription, "body_md"):
        flags.extend(_check_body_length(transcription, paper_id, question_id))

    flags.extend(_check_latex(transcription, paper_id, question_id))

    if figure_inventory is not None and hasattr(transcription, "body_md"):
        flags.extend(
            _check_figure_citations(transcription, paper_id, question_id, figure_inventory)
        )

    return flags


# ---------------------------------------------------------------------------
# Crop checks — geometry only, no transcription required
# ---------------------------------------------------------------------------

# Marks are printed as "[3]" on a question paper and as CAIE codes on a mark
# scheme. Either proves the crop reached the edge of the content.
_CROP_MARKS = re.compile(r"\[\s*\d+\s*\]|\b(?:D?[MABC]\d|SC\b|FT\b|OE\b)")
_CROP_FURNITURE = re.compile(
    r"\u00a9\s*UCLES|Page \d+ of \d+|\[\s*Turn over|PUBLISHED|"
    r"Cambridge (?:IGCSE|Assessment)|\d{4}/\d\d/[A-Z]/[A-Z]/\d\d"
)
# One is enough. Losing a single token can make a question unanswerable —
# the constant in "y = ax + 9" — while leaving it looking complete, which
# is worse than losing a whole sentence a reader would notice was missing.
_CROP_ERASED_WORD_LIMIT = 1
# How far inside the grid's right edge a crop may stop before the Marks column
# is at risk. The column itself is roughly 40pt wide.
_MARKS_COLUMN_SLACK = 12.0
# Where in the first strip the question number must appear. A number found
# halfway down a long crop is part of the question, not its label — but on a
# short crop a quarter of the height is less than one line of text, so there
# is a floor of roughly two lines. A History essay question missed by 1.1 pt
# without it.
_CROP_NUMBER_BAND = 0.25
_CROP_NUMBER_BAND_FLOOR = 36.0


def run_crop_checks(
    pdf_path,
    span,
    rendered_span,
    doc_type: str,
    paper_id: int | None,
    question_id: int | None = None,
) -> list["ReviewFlag"]:
    """Check the rendered crop against the page it was cut from.

    This is what protects a crop-first bank. Everything else in this module
    reads a transcription, which in crop-only mode does not exist; these read
    the strips and the PDF text layer directly.

    Import is local so the module keeps working for callers that never render.
    """
    import fitz

    flags: list[ReviewFlag] = []
    root = rendered_span.root_number

    if not rendered_span.strips:
        return [ReviewFlag(
            question_id=question_id, paper_id=paper_id,
            issue_type=ISSUE_CROP_EMPTY, severity=SEVERITY_HIGH,
            message=f"Question {root} rendered no strips",
            evidence={"root_number": root},
        )]

    # Erase boxes live on the stage-one regions, not on the rendered strip.
    erase_by_page: dict[int, tuple] = {}
    for region in span.regions:
        erase_by_page.setdefault(region.page, ())
        erase_by_page[region.page] += tuple(region.erase_bboxes)

    visible: list[str] = []
    erased: list[str] = []
    with fitz.open(pdf_path) as document:
        for strip in rendered_span.strips:
            if not 1 <= strip.page <= document.page_count:
                continue
            page = document[strip.page - 1]
            kept, casualties = _crop_words(
                page, strip.bbox, erase_by_page.get(strip.page, ()))
            visible.append(kept)
            erased.extend(casualties)

    body = "\n".join(visible)

    if doc_type != "ms" and not _number_visible_at_top(
            pdf_path, rendered_span, root):
        flags.append(ReviewFlag(
            question_id=question_id, paper_id=paper_id,
            issue_type=ISSUE_CROP_MISSING_NUMBER, severity=SEVERITY_MEDIUM,
            message=f"Crop for question {root} does not begin at its number",
            evidence={"root_number": root, "head": body.strip()[:80]},
        ))

    # A question paper prints "[3]"; a mark scheme's Marks column is often bare
    # integers, indistinguishable from any other number in the answer text. So
    # the paper is checked by text and the mark scheme by geometry: does the
    # crop actually reach the right-hand edge of the grid. That is the check
    # that would have caught the rotation bug, which trimmed exactly that
    # column off every rotated mark scheme.
    if doc_type == "ms":
        flags.extend(_check_marks_column(
            pdf_path, rendered_span, paper_id, question_id, root))
    elif not _CROP_MARKS.search(body):
        flags.append(ReviewFlag(
            question_id=question_id, paper_id=paper_id,
            issue_type=ISSUE_CROP_NO_MARKS, severity=SEVERITY_MEDIUM,
            message=f"No mark allocation visible in the crop for question {root}",
            evidence={"root_number": root},
        ))

    leak = _CROP_FURNITURE.search(body)
    if leak:
        flags.append(ReviewFlag(
            question_id=question_id, paper_id=paper_id,
            issue_type=ISSUE_CROP_FURNITURE, severity=SEVERITY_LOW,
            message=f"Page furniture visible in the crop for question {root}",
            evidence={"root_number": root, "match": leak.group(0)[:60]},
        ))

    # Only question papers erase anything that could be content. A mark
    # scheme's erase boxes come from _ms_furniture, which by construction only
    # covers the bands above and below the grid, so every word they remove is
    # furniture and checking them would flag the running header every time.
    # Every casualty counts. The old filter kept only words with three or more
    # ASCII letters, so an erased numeral, unit, symbol or short word scored
    # nothing at all — a question could lose the constant that makes it
    # answerable and still read as clean.
    lost = list(erased) if doc_type != "ms" else []
    if len(lost) >= _CROP_ERASED_WORD_LIMIT:
        flags.append(ReviewFlag(
            question_id=question_id, paper_id=paper_id,
            issue_type=ISSUE_CROP_ERASED_TEXT, severity=SEVERITY_HIGH,
            message=f"An erase box covered {len(lost)} words of question {root}",
            evidence={"root_number": root, "words": lost[:10]},
        ))

    return flags


def _number_visible_at_top(pdf_path, rendered_span, root: int) -> bool:
    """Is the question's own number printed near the top of its crop?

    Asked geometrically rather than by reading the extracted text in order.
    Three different layouts defeated the text approach: a caption above the
    question ("insert", or a filename in a Computer Science paper), the two
    columns of a multiple-choice paper interleaving when sorted by
    coordinate, and papers whose internal block order puts the stem before
    the number. All three produced false positives on crops that were fine.
    Position on the page does not care about any of that.
    """
    import fitz

    if not rendered_span.strips:
        return False
    strip = rendered_span.strips[0]
    with fitz.open(pdf_path) as document:
        if not 1 <= strip.page <= document.page_count:
            return False
        page = document[strip.page - 1]
        matrix = page.rotation_matrix
        clip = fitz.Rect(*strip.bbox)
        band = clip.y0 + max(clip.height * _CROP_NUMBER_BAND,
                             _CROP_NUMBER_BAND_FLOOR)
        wanted = str(root)
        for wx0, wy0, wx1, wy1, word, *_ in page.get_text("words"):
            if word.strip(".)") != wanted:
                continue
            box = fitz.Rect(wx0, wy0, wx1, wy1) * matrix
            if (box & clip).is_empty:
                continue
            if box.y0 <= band:
                return True
    return False


def _check_marks_column(
    pdf_path,
    rendered_span,
    paper_id: int | None,
    question_id: int | None,
    root: int,
) -> list["ReviewFlag"]:
    """Does a mark-scheme crop reach the right edge of its grid?

    find_tables reports display coordinates, the same space the strip is
    clipped in, so the two are directly comparable.
    """
    import fitz

    with fitz.open(pdf_path) as document:
        for strip in rendered_span.strips:
            if not 1 <= strip.page <= document.page_count:
                continue
            page = document[strip.page - 1]
            try:
                tables = page.find_tables().tables
            except Exception:
                continue
            if not tables:
                continue
            grid_right = max(float(table.bbox[2]) for table in tables)
            if strip.bbox[2] < grid_right - _MARKS_COLUMN_SLACK:
                return [ReviewFlag(
                    question_id=question_id, paper_id=paper_id,
                    issue_type=ISSUE_CROP_NO_MARKS, severity=SEVERITY_HIGH,
                    message=(
                        f"Crop for question {root} stops short of the grid, "
                        "so the Marks column is cut off"
                    ),
                    evidence={
                        "root_number": root, "page": strip.page,
                        "crop_right": round(strip.bbox[2], 1),
                        "grid_right": round(grid_right, 1),
                    },
                )]
    return []


def _crop_words(page, clip, erase_bboxes) -> tuple[str, list[str]]:
    """Text a reader would see in one strip, and the words the erase removed.

    Word boxes come back in the unrotated page space while the strip is clipped
    in display space, so both are mapped through the page's rotation before
    being compared.
    """
    import fitz

    matrix = page.rotation_matrix
    rect = fitz.Rect(*clip)
    erased = [fitz.Rect(*box) for box in erase_bboxes]

    # Ordered by the PDF's own block/line/word structure rather than by
    # coordinate. Sorting by (y, x) interleaves the columns of a two-column
    # multiple-choice paper, so the question number ends up buried among the
    # answer options of the column beside it and the crop reads as scrambled
    # when it is perfectly fine.
    kept: list[tuple[tuple[int, int, int], str]] = []
    casualties: list[str] = []
    for wx0, wy0, wx1, wy1, word, *order in page.get_text("words"):
        box = fitz.Rect(wx0, wy0, wx1, wy1) * matrix
        if (box & rect).is_empty:
            continue
        area = box.get_area()
        covered = 0.0
        for erase in erased:
            overlap = box & erase
            if not overlap.is_empty and area:
                covered = max(covered, overlap.get_area() / area)
        if covered >= erase_guard.COVERAGE_THRESHOLD:
            # One definition of "content", shared with the render-time guard —
            # see erase_guard. The local regexes it replaces whitelisted every
            # one- and two-character token, which is why a lost "9" was never
            # reported.
            if erase_guard.is_content_token(word):
                casualties.append(erase_guard.normalise_token(word))
            continue
        position = tuple(int(value) for value in order[:3]) if len(order) >= 3 \
            else (0, 0, 0)
        kept.append((position, word))

    kept.sort(key=lambda item: item[0])
    return " ".join(word for _, word in kept), casualties


def _check_latex(
    transcription,
    paper_id: int | None,
    question_id: int | None,
) -> list[ReviewFlag]:
    """Flag mathematics still holding JSON escape damage.

    A model that single-escapes ``\\frac`` yields a formfeed once the JSON is
    decoded. Recovery handles the known cases; anything left is a formula that
    would render as prose, which a reviewer needs to see.
    """
    from .transcribe import has_damaged_latex

    body = getattr(transcription, "body_md", None) or getattr(transcription, "answer_md", "")
    if body and has_damaged_latex(body):
        return [ReviewFlag(
            question_id=question_id,
            paper_id=paper_id,
            issue_type=ISSUE_LATEX_INVALID,
            severity=SEVERITY_HIGH,
            message="LaTeX contains control characters from JSON escape damage",
            evidence={"sample": repr(body[:200])},
        )]
    return []


def _check_confidence(
    transcription,
    paper_id: int | None,
    question_id: int | None,
    threshold: float,
) -> list[ReviewFlag]:
    """Check if confidence is below threshold."""
    if transcription.confidence < threshold:
        return [ReviewFlag(
            question_id=question_id,
            paper_id=paper_id,
            issue_type=ISSUE_LOW_CONFIDENCE,
            severity=SEVERITY_MEDIUM if transcription.confidence >= 0.5 else SEVERITY_HIGH,
            message=f"Model confidence {transcription.confidence:.2f} below threshold {threshold:.2f}",
            evidence={"confidence": transcription.confidence, "threshold": threshold},
        )]
    return []


def _check_parts_sum(
    transcription,
    paper_id: int | None,
    question_id: int | None,
) -> list[ReviewFlag]:
    """Check if part marks sum to total_marks."""
    if not transcription.parts or transcription.total_marks is None:
        return []

    part_sum = sum(part.get("marks", 0) or 0 for part in transcription.parts if isinstance(part, dict))

    if part_sum != transcription.total_marks:
        return [ReviewFlag(
            question_id=question_id,
            paper_id=paper_id,
            issue_type=ISSUE_MARKS_MISMATCH,
            severity=SEVERITY_MEDIUM,
            message=f"Part marks sum ({part_sum}) doesn't match total_marks ({transcription.total_marks})",
            evidence={
                "parts": transcription.parts,
                "total_marks": transcription.total_marks,
                "sum": part_sum,
            },
        )]
    return []


def _check_body_length(
    transcription,
    paper_id: int | None,
    question_id: int | None,
) -> list[ReviewFlag]:
    """Check if body_md is suspiciously short relative to expected content."""
    if not transcription.body_md:
        return [ReviewFlag(
            question_id=question_id,
            paper_id=paper_id,
            issue_type=ISSUE_SUSPICIOUS_LENGTH,
            severity=SEVERITY_HIGH,
            message="body_md is empty",
            evidence={"body_length": 0},
        )]

    # Very short bodies with figures might indicate truncated transcription
    body_len = len(transcription.body_md.strip())
    has_figures = bool(transcription.figures_used)

    # Only flag extremely short bodies (< 15 chars) without figures
    if body_len < 15 and not has_figures:
        return [ReviewFlag(
            question_id=question_id,
            paper_id=paper_id,
            issue_type=ISSUE_SUSPICIOUS_LENGTH,
            severity=SEVERITY_MEDIUM,
            message=f"Body suspiciously short ({body_len} chars) with no figures",
            evidence={"body_length": body_len},
        )]

    return []


def create_ledger_key(
    source_sha256: str,
    root_number: int | None,
    model: str,
    prompt_version: str,
    stage: str,
) -> str:
    """Create a unique work key for the run ledger.

    The key combines all factors that would change the output, so a prompt or
    model change re-runs only what it affects.
    """
    key_data = f"{source_sha256}:{root_number}:{model}:{prompt_version}:{stage}"
    return sha256(key_data.encode()).hexdigest()


class RunLedger:
    """Per-question resume ledger for long-running extractions.

    The ledger lives in the same SQLite file as the extraction store. Opening a
    second connection to write it deadlocks against the store's open write
    transaction — SQLite allows only one writer, so every ``record_success``
    raised "database is locked" and the whole document was reported as failed
    even though its questions had already been written. Pass the store's own
    ``connection`` to share the single writer; ``db_path`` alone is still
    supported for standalone use such as reporting.
    """

    def __init__(
        self,
        db_path: Path | str | None = None,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> None:
        if db_path is None and connection is None:
            raise ValueError("RunLedger requires either db_path or connection")
        self.db_path = Path(db_path) if db_path is not None else None
        self._shared = connection
        self._ensure_schema()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        """Yield a usable connection, reusing the caller's when it has one.

        When the connection is shared, the caller owns the transaction and this
        must not commit; committing here would end the caller's transaction
        early and defeat per-document atomicity.
        """
        if self._shared is not None:
            yield self._shared
            return
        connection = sqlite3.connect(self.db_path, timeout=30.0)
        try:
            # Wait out a concurrent writer rather than failing immediately.
            connection.execute("PRAGMA busy_timeout = 30000")
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _ensure_schema(self) -> None:
        """Ensure the ledger table exists."""
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS bank_run_ledger (
                    work_key TEXT PRIMARY KEY,
                    stage TEXT NOT NULL,
                    source_sha256 TEXT NOT NULL,
                    root_number INTEGER,
                    status TEXT NOT NULL,
                    detail TEXT,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    completed_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_ledger_source
                ON bank_run_ledger(source_sha256)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_ledger_status
                ON bank_run_ledger(status, stage)
            """)

    def is_completed(self, work_key: str) -> bool:
        """Check if a work item has already completed successfully."""
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT status FROM bank_run_ledger WHERE work_key = ?",
                (work_key,),
            )
            row = cursor.fetchone()
            return row is not None and row[0] == "ok"

    def record_success(
        self,
        work_key: str,
        stage: str,
        source_sha256: str,
        root_number: int | None,
        input_tokens: int,
        output_tokens: int,
    ) -> None:
        """Record a successful completion."""
        with self._connect() as conn:
            conn.execute("""
                INSERT OR REPLACE INTO bank_run_ledger
                (work_key, stage, source_sha256, root_number, status,
                 input_tokens, output_tokens)
                VALUES (?, ?, ?, ?, 'ok', ?, ?)
            """, (work_key, stage, source_sha256, root_number, input_tokens, output_tokens))

    def record_failure(
        self,
        work_key: str,
        stage: str,
        source_sha256: str,
        root_number: int | None,
        detail: str,
    ) -> None:
        """Record a failed attempt."""
        with self._connect() as conn:
            conn.execute("""
                INSERT OR REPLACE INTO bank_run_ledger
                (work_key, stage, source_sha256, root_number, status, detail)
                VALUES (?, ?, ?, ?, 'failed', ?)
            """, (work_key, stage, source_sha256, root_number, detail))

    def get_pending_work(
        self,
        stage: str,
        source_sha256: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get work items that haven't completed yet."""
        with self._connect() as conn:
            if source_sha256:
                cursor = conn.execute(
                    """SELECT work_key, source_sha256, root_number, stage
                       FROM bank_run_ledger
                       WHERE stage = ? AND source_sha256 = ? AND status != 'ok'
                       ORDER BY source_sha256, root_number""",
                    (stage, source_sha256),
                )
            else:
                cursor = conn.execute(
                    """SELECT work_key, source_sha256, root_number, stage
                       FROM bank_run_ledger
                       WHERE stage = ? AND status != 'ok'
                       ORDER BY source_sha256, root_number""",
                    (stage,),
                )
            return [
                {
                    "work_key": row[0],
                    "source_sha256": row[1],
                    "root_number": row[2],
                    "stage": row[3],
                }
                for row in cursor.fetchall()
            ]

    def get_statistics(self) -> dict[str, Any]:
        """Get run statistics from the ledger."""
        with self._connect() as conn:
            # Total entries
            total = conn.execute("SELECT COUNT(*) FROM bank_run_ledger").fetchone()[0]

            # Status breakdown
            status_counts = conn.execute("""
                SELECT status, COUNT(*) FROM bank_run_ledger GROUP BY status
            """).fetchall()

            # Stage breakdown
            stage_counts = conn.execute("""
                SELECT stage, COUNT(*) FROM bank_run_ledger GROUP BY stage
            """).fetchall()

            # Token usage
            tokens = conn.execute("""
                SELECT SUM(input_tokens), SUM(output_tokens) FROM bank_run_ledger
            """).fetchone()

            return {
                "total_entries": total,
                "by_status": dict(status_counts),
                "by_stage": dict(stage_counts),
                "total_input_tokens": tokens[0] or 0,
                "total_output_tokens": tokens[1] or 0,
            }


# A CAIE figure caption: "Fig. 3.1", "Fig 12.2". Tables are deliberately not
# matched — a table is usually transcribed as HTML rather than cited as an
# asset, so requiring a citation for one would flag correct work.
_FIGURE_CAPTION = re.compile(r"\bFig\.?\s*(\d+\.\d+)")
_ASSET_CITATION = re.compile(r"!\[[^\]]*\]\(asset:([A-Za-z0-9_-]+)\)")


def _check_figure_citations(
    transcription,
    paper_id: int | None,
    question_id: int | None,
    figure_inventory: Sequence[Mapping[str, Any]],
) -> list[ReviewFlag]:
    """Catch figures that are missing, or cited as the wrong image.

    A wrong citation is worse than a missing one: it renders confidently, and
    nothing else in QA can see it. On 0620_s23_qp_41 Q3 all three citations
    pointed at the wrong crop while confidence read 0.95 and every other check
    passed, so the paper published a carbon dioxide diagram where the sodium
    and oxygen configurations belonged.

    Three signals, all advisory:

    1.  The body names more figures than it cites. Either the model never
        placed one, or post-processing stripped an id the inventory did not
        contain — both leave the student reading about a picture that is not
        there.
    2.  Citations on a page skip that page's first figure but use a later one.
        That is the shape an off-by-one leaves behind.
    3.  Citations do not run down the page in the order the body uses them.
    """
    body = getattr(transcription, "body_md", "") or ""
    flags: list[ReviewFlag] = []

    cited_in_order: list[str] = []
    for match in _ASSET_CITATION.finditer(body):
        if match.group(1) not in cited_in_order:
            cited_in_order.append(match.group(1))
    cited = set(cited_in_order)

    captions = {match.group(1) for match in _FIGURE_CAPTION.finditer(body)}

    # 1. Named but not shown.
    if len(captions) > len(cited):
        flags.append(
            ReviewFlag(
                question_id=question_id,
                paper_id=paper_id,
                issue_type=ISSUE_FIGURE_UNCITED,
                severity=SEVERITY_HIGH,
                message=(
                    f"body names {len(captions)} figure(s) but cites {len(cited)}: "
                    "a referenced figure will be missing"
                ),
                evidence={
                    "captions": sorted(captions),
                    "cited": cited_in_order,
                    "available": [str(figure.get("id")) for figure in figure_inventory],
                },
            )
        )

    if not cited:
        return flags

    order = {str(figure.get("id")): index for index, figure in enumerate(figure_inventory)}

    # 2. Skipped the top of a page while using what sits below it.
    by_page: dict[Any, list[str]] = {}
    for figure in figure_inventory:
        by_page.setdefault(figure.get("page"), []).append(str(figure.get("id")))

    for page, ids in by_page.items():
        used = [figure_id for figure_id in ids if figure_id in cited]
        if not used or ids[0] in cited:
            continue
        flags.append(
            ReviewFlag(
                question_id=question_id,
                paper_id=paper_id,
                issue_type=ISSUE_FIGURE_CITATION_OFFSET,
                severity=SEVERITY_MEDIUM,
                message=(
                    f"page {page}: cites {', '.join(used)} but not {ids[0]}, "
                    "the first figure on the page — citations may be off by one"
                ),
                evidence={"page": page, "available": ids, "cited": used},
            )
        )

    # 3. Cited out of reading order.
    positions = [order[figure_id] for figure_id in cited_in_order if figure_id in order]
    if positions != sorted(positions):
        flags.append(
            ReviewFlag(
                question_id=question_id,
                paper_id=paper_id,
                issue_type=ISSUE_FIGURE_CITATION_ORDER,
                severity=SEVERITY_MEDIUM,
                message=(
                    "figures are cited out of reading order: "
                    f"{', '.join(cited_in_order)}"
                ),
                evidence={
                    "cited": cited_in_order,
                    "available": [str(figure.get("id")) for figure in figure_inventory],
                },
            )
        )

    return flags
