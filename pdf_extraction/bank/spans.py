"""Stage 1 — deterministic root-question span detection.

Question papers and mark schemes need different strategies:

*   Question papers are prose in reading order, so the existing
    ``question_images`` detector applies directly. It scores root-number
    candidates on typography and position, then picks the best increasing
    sequence with a Viterbi decode.
*   CAIE mark schemes are landscape tables whose text extracts in scrambled
    order, so line-based detection finds almost nothing. Their layout is
    highly regular though — a ``Question | Answer | Marks | Guidance`` grid
    whose leftmost column holds ``1``, ``3(a)``, ``7(a)(i)`` — so we read
    spans off the table geometry instead.

Both paths return the same ``DocumentSpans``, so downstream stages never
need to know which was used. Nothing here calls a model or a network.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path
import re
from typing import Any, Literal

import fitz

from ..question_images.detector import DetectionResult, DetectedRoot, detect_roots
from ..question_images.evidence import (
    DocumentEvidence,
    extract_document_evidence,
    file_sha256,
)
from ..question_images.models import DETECTOR_VERSION, SourceRegion
from ..question_images.regions import build_source_regions

SPAN_DETECTOR_VERSION = f"bank-spans-v1+{DETECTOR_VERSION}"

DocType = Literal["qp", "ms", "in"]

RENDER_DPI = 200

# A mark-scheme grid is identified by its header row rather than by column
# count, because the extracted grid is padded with empty spacer columns.
_MS_HEADER = re.compile(r"^\s*question\s*$", re.IGNORECASE)
_MS_MARKS_HEADER = re.compile(r"^\s*marks?\s*$", re.IGNORECASE)

# Leftmost-column labels: "1", "3(a)", "7(a)(i)", "12 (b) (ii)".
_MS_LABEL = re.compile(
    r"^\s*(?P<number>\d{1,3})\s*(?P<parts>(?:\([a-z0-9ivx]{1,4}\)\s*)*)$",
    re.IGNORECASE,
)

# CAIE marking codes, used to recognise a mark-scheme grid that has no header.
_MS_MARK_CODE = re.compile(r"\b(?:D?[MAB]\d|SC\b|FT\b|ISW\b|OE\b)")

# A page carrying less text than this is a cover, a divider, or blank, and is
# not worth a region of its own when a question spans across it.
_MIN_CONTENT_CHARS = 120

# Below this a region is detector noise — the next label starting flush against
# the top of a page, most often — and would render a sliver.
_MIN_REGION_HEIGHT = 6.0


@dataclass(frozen=True)
class PageRegion:
    """One rectangle of one page belonging to a root question.

    ``erase_bboxes`` are areas to paint over before rendering: dotted answer
    rules, barcodes, and repeated page furniture. Excluding them here means
    the model never sees them.
    """

    page: int
    bbox: tuple[float, float, float, float]
    erase_bboxes: tuple[tuple[float, float, float, float], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "page": self.page,
            "bbox": [round(value, 3) for value in self.bbox],
            "erase_bboxes": [[round(v, 3) for v in box] for box in self.erase_bboxes],
        }


@dataclass(frozen=True)
class RootSpan:
    """One complete top-level question, possibly spanning several pages."""

    root_number: int
    regions: tuple[PageRegion, ...]
    part_labels: tuple[str, ...] = ()
    visual_count: int = 0
    confidence: float = 1.0
    diagnostics: tuple[dict[str, Any], ...] = ()
    # Where the question's own number was detected, as (page, y).
    #
    # A crop does not always begin at its number: a paper prints "SECTION A:
    # CORE CONTENT / Answer any two questions from this Section." above the
    # first question of a section, and that heading is deliberately part of the
    # crop. So "does this crop begin at its number?" cannot be answered from
    # the crop's own top edge, and the QA check was left guessing from the
    # vocabulary of whatever stood above the number -- which works for a fixed
    # rubric and cannot work for "based on the extract from Oppenheimer, by Tom
    # Morton-Smith".
    #
    # The detector knew the answer all along. Carried here, the check becomes
    # the question actually worth asking: does the crop reach the number, or
    # does it start below it and so open part-way through the question?
    number_anchor: tuple[int, float] | None = None

    @property
    def page_start(self) -> int:
        return min(region.page for region in self.regions)

    @property
    def page_end(self) -> int:
        return max(region.page for region in self.regions)

    @property
    def pages(self) -> tuple[int, ...]:
        return tuple(sorted({region.page for region in self.regions}))

    def to_dict(self) -> dict[str, Any]:
        return {
            "root_number": self.root_number,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "regions": [region.to_dict() for region in self.regions],
            "part_labels": list(self.part_labels),
            "visual_count": self.visual_count,
            "confidence": round(self.confidence, 3),
            "diagnostics": list(self.diagnostics),
            "number_anchor": (
                [self.number_anchor[0], round(self.number_anchor[1], 3)]
                if self.number_anchor else None
            ),
        }


@dataclass(frozen=True)
class DocumentSpans:
    source_path: str
    source_sha256: str
    doc_type: str
    page_count: int
    strategy: str
    spans: tuple[RootSpan, ...] = ()
    used_ocr: bool = False
    diagnostics: tuple[dict[str, Any], ...] = ()
    # Populated only for multiple-choice mark schemes, which are answer
    # grids rather than prose. These are fully recovered here, so no model
    # call is ever made for them.
    answer_key: tuple[tuple[int, str], ...] = ()
    # Geometry already found while locating mark-scheme question rows. Kept
    # in memory for rendering; it is derived data, not part of the stored span.
    table_bboxes: dict[int, tuple[tuple[float, float, float, float], ...]] = field(
        default_factory=dict, repr=False, compare=False,
    )

    @property
    def root_numbers(self) -> tuple[int, ...]:
        return tuple(span.root_number for span in self.spans)

    @property
    def numbering_gaps(self) -> tuple[int, ...]:
        """Root numbers missing from an otherwise contiguous run.

        These are the only pages worth spending a model call on to recover,
        which keeps gap-filling to a few hundred calls corpus-wide.
        """
        numbers = sorted(set(self.root_numbers))
        if len(numbers) < 2:
            return ()
        return tuple(
            value
            for value in range(numbers[0], numbers[-1] + 1)
            if value not in numbers
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": SPAN_DETECTOR_VERSION,
            "source_path": self.source_path,
            "source_sha256": self.source_sha256,
            "doc_type": self.doc_type,
            "page_count": self.page_count,
            "strategy": self.strategy,
            "used_ocr": self.used_ocr,
            "numbering_gaps": list(self.numbering_gaps),
            "diagnostics": list(self.diagnostics),
            "answer_key": [list(item) for item in self.answer_key],
            "spans": [span.to_dict() for span in self.spans],
        }


def detect_root_spans(
    path: Path | str,
    doc_type: DocType,
    *,
    evidence: DocumentEvidence | None = None,
) -> DocumentSpans:
    """Locate every top-level question in one PDF.

    ``evidence`` may be passed in when the caller has already parsed the
    document, since that parse is the expensive part.
    """
    path = Path(path)
    if doc_type == "ms":
        # Multiple-choice keys are checked first: they are pure answer grids
        # that the table and prose detectors both misread.
        key = _detect_answer_key(path)
        if key is not None:
            return key
        spans = _detect_ms_spans(path)
        if spans.spans:
            return spans
        # Older mark schemes predate the tabular layout; the prose detector
        # is the better fallback for those.
        prose = _detect_prose_spans(path, doc_type, evidence)
        return _with_diagnostic(
            replace(prose, table_bboxes=spans.table_bboxes),
            {"reason": "ms_table_detection_empty"},
        )
    return _detect_prose_spans(path, doc_type, evidence)


# ---------------------------------------------------------------------------
# Multiple-choice answer keys
# ---------------------------------------------------------------------------

_MIN_ANSWER_KEY_ENTRIES = 15
_MAX_ROOT_NUMBER = 60


def _detect_answer_key(path: Path) -> DocumentSpans | None:
    """Recover a multiple-choice key, or ``None`` if this is not one.

    Both CAIE layouts — pre-2018 ``Question Number | Key`` and post-2018
    ``Question | Answer | Marks`` — reduce to a run of question numbers each
    followed immediately by a single option letter.

    The IB reduces to the same thing, except that it writes the number with a
    trailing period: ``1.`` then ``B``. That one character meant this detector
    recognised **no** IB answer key at all -- 221 papers and 7,677 keys, the
    whole of IB Physics, Chemistry, Biology and Sports Science Paper 1, came
    through as unkeyed. A generated IB Paper 1 was then forty multiple-choice
    questions sent to a model to mark with no key to mark them against.

    Tolerating the period is safe rather than merely cheap: across all 1,854 IB
    mark schemes it newly claims 221 papers and every one of them is a Paper 1.
    Nothing structured is misread as a key, which is the failure that would
    matter -- ``run`` returns early on a detected key, so a false positive
    would cost that paper its real mark scheme.
    """
    pairs: dict[int, str] = {}
    page_count = 0
    with fitz.open(path) as document:
        page_count = document.page_count
        for page in document:
            tokens = page.get_text().split()
            for index, token in enumerate(tokens[:-1]):
                # The IB numbers its key "1." where CAIE writes "1".
                if token.endswith(".") and len(token) > 1:
                    token = token[:-1]
                # str.isdigit() accepts Unicode superscripts such as "3²",
                # which int() then rejects, so require plain ASCII digits.
                if not (token.isascii() and token.isdigit()):
                    continue
                number = int(token)
                if not 1 <= number <= _MAX_ROOT_NUMBER:
                    continue
                following = tokens[index + 1]
                if len(following) == 1 and following in "ABCD":
                    pairs.setdefault(number, following)

    if len(pairs) < _MIN_ANSWER_KEY_ENTRIES:
        return None

    return DocumentSpans(
        source_path=str(path),
        source_sha256=file_sha256(path),
        doc_type="ms",
        page_count=page_count,
        strategy="answer_key",
        answer_key=tuple(sorted(pairs.items())),
    )


# ---------------------------------------------------------------------------
# Question papers — reuse the existing prose detector
# ---------------------------------------------------------------------------


def _detect_prose_spans(
    path: Path,
    doc_type: str,
    evidence: DocumentEvidence | None,
) -> DocumentSpans:
    evidence = evidence or extract_document_evidence(path)
    detection = detect_roots(evidence)
    if doc_type == "ms" and "IB PAST PAPERS - YEAR" in path.parts:
        # IB markbands print score levels 0, 1, 2, ... as bare numbers. The
        # question detector accepts those as roots and chops a real answer into
        # rubric rows. Actual question headings in these prose mark schemes
        # are punctuated ("1.", "2."). Build regions from those headings so
        # the intervening markband remains with its question.
        numbered = sorted(
            (candidate for candidate in detection.candidates
             if re.fullmatch(r"\s*\d{1,2}[.)]\s*", candidate.text)),
            key=lambda candidate: candidate.position,
        )
        if numbered:
            selected = []
            last_number = 0
            for candidate in numbered:
                if candidate.number > last_number:
                    selected.append(DetectedRoot(candidate))
                    last_number = candidate.number
            detection = DetectionResult(tuple(selected), detection.candidates,
                                        detection.diagnostics)
    root_regions = build_source_regions(evidence, detection, dpi=RENDER_DPI)

    spans: list[RootSpan] = []
    for entry in root_regions:
        regions = tuple(_page_region(region) for region in entry.regions)
        if not regions:
            continue
        spans.append(RootSpan(
            root_number=entry.root.number,
            regions=regions,
            visual_count=entry.essential_visuals,
            confidence=_confidence_from_score(entry.root.candidate.score),
            diagnostics=tuple(entry.root.diagnostics) + tuple(entry.diagnostics),
            number_anchor=(
                entry.root.candidate.page,
                entry.root.candidate.bbox[1],
            ),
        ))

    return DocumentSpans(
        source_path=str(path),
        source_sha256=evidence.source_sha256,
        doc_type=doc_type,
        page_count=len(evidence.pages),
        strategy="prose_ms_numbered" if doc_type == "ms" and "IB PAST PAPERS - YEAR" in path.parts and numbered else "prose",
        spans=tuple(spans),
        used_ocr=evidence.used_ocr,
        diagnostics=tuple(detection.diagnostics),
    )


def _page_region(region: SourceRegion) -> PageRegion:
    return PageRegion(
        page=region.page,
        bbox=region.bbox,
        erase_bboxes=region.erase_bboxes,
    )


def _confidence_from_score(score: float) -> float:
    """Map the detector's unbounded candidate score onto 0-1.

    The detector accepts at 2.4 and strong candidates land around 5-6, so
    that band is stretched across the usable range.
    """
    return max(0.0, min(1.0, (score - 2.4) / 3.6))


# ---------------------------------------------------------------------------
# Mark schemes — read spans off the table grid
# ---------------------------------------------------------------------------


def _detect_ms_spans(path: Path) -> DocumentSpans:
    rows: list[tuple[int, int, float, float, str]] = []
    page_sizes: dict[int, tuple[float, float]] = {}
    pages_with_content: set[int] = set()
    page_count = 0
    digest = file_sha256(path)

    furniture: dict[int, tuple[tuple[float, float, float, float], ...]] = {}
    table_bboxes: dict[int, tuple[tuple[float, float, float, float], ...]] = {}

    with fitz.open(path) as document:
        page_count = document.page_count
        for page_index, page in enumerate(document):
            page_number = page_index + 1
            page_sizes[page_number] = (page.rect.width, page.rect.height)
            if len(page.get_text().strip()) >= _MIN_CONTENT_CHARS:
                pages_with_content.add(page_number)
            try:
                found_tables = tuple(page.find_tables().tables)
            except Exception:
                found_tables = ()
            table_bboxes[page_index] = tuple(tuple(table.bbox) for table in found_tables)
            tables = _question_tables(page, found_tables)
            for table, question_column in tables:
                rows.extend(_label_rows(table, question_column, page_number))
            furniture[page_number] = _ms_furniture(page, [t for t, _ in tables])

    if not rows:
        return DocumentSpans(
            source_path=str(path),
            source_sha256=digest,
            doc_type="ms",
            page_count=page_count,
            strategy="ms_table",
            table_bboxes=table_bboxes,
        )

    rows.sort(key=lambda row: (row[0], row[2]))
    spans = _spans_from_rows(rows, page_sizes, pages_with_content, furniture)
    return DocumentSpans(
        source_path=str(path),
        source_sha256=digest,
        doc_type="ms",
        page_count=page_count,
        strategy="ms_table",
        spans=spans,
        table_bboxes=table_bboxes,
    )


def _question_tables(page: fitz.Page,
                     found_tables: tuple[Any, ...] | None = None) -> list[tuple[Any, int]]:
    """Yield ``(table, question_column)`` for each mark-scheme grid on a page.

    The question column is located from the header row rather than assumed
    to be column 0, and only that column is ever read for labels. Scanning
    the whole row instead would pick up answer text — a bare ``4`` inside a
    formula is indistinguishable from a question label out of context.
    """
    if found_tables is None:
        try:
            found_tables = tuple(page.find_tables().tables)
        except Exception:
            return []

    result: list[tuple[Any, int]] = []
    for table in found_tables:
        extracted = table.extract()
        if not extracted:
            continue
        column = _question_column(extracted)
        if column is not None:
            header_cells = [(cell or "").strip() for row in extracted[:3] for cell in row]
            if any(_MS_MARKS_HEADER.match(cell) for cell in header_cells):
                result.append((table, column))
            continue
        if _is_headerless_grid(extracted):
            result.append((table, 0))
    return result


def _question_column(extracted: list[list[str | None]]) -> int | None:
    """Index of the column headed ``Question``, if the grid has one."""
    for row in extracted[:3]:
        for index, cell in enumerate(row):
            if _MS_HEADER.match((cell or "").strip()):
                return index
    return None


def _is_headerless_grid(extracted: list[list[str | None]]) -> bool:
    """Recognise the pre-2018 mark-scheme layout.

    Those grids carry no header row at all — just
    ``label | answer | mark codes | totals`` — so they are identified by
    column 0 reading as a question label on most rows, and by the presence
    of CAIE mark codes (``M1``, ``A1``, ``B1``, ``DM1``) further right.
    """
    labelled = 0
    coded = 0
    for row in extracted:
        if not row:
            continue
        if _MS_LABEL.match((row[0] or "").strip().replace("\n", " ")):
            labelled += 1
        if any(_MS_MARK_CODE.search((cell or "")) for cell in row[1:]):
            coded += 1
    return labelled >= 1 and coded >= 1 and labelled >= len(extracted) * 0.5


def _label_rows(
    table: Any,
    question_column: int,
    page_number: int,
) -> list[tuple[int, int, float, float, str]]:
    """Extract ``(page, root, y_top, y_bottom, label)`` for each labelled row.

    A mark-scheme row only carries a label when a new question or sub-part
    begins; continuation rows are blank and belong to whichever label
    preceded them.
    """
    extracted = table.extract()
    result: list[tuple[int, int, float, float, str]] = []
    row_boxes = _row_boxes(table)

    for row_index, row in enumerate(extracted):
        if row_index >= len(row_boxes):
            break
        label = _label_at(row, question_column)
        if not label:
            continue
        match = _MS_LABEL.match(label)
        if not match:
            continue
        top, bottom = row_boxes[row_index]
        if not result:
            # The first label in a grid takes the grid's own top edge, so the
            # "Question | Answer | Marks" header comes with it. Starting at the
            # row boundary instead sliced that header in half, and the header
            # is what tells a reader which column the mark codes are in.
            top = min(top, float(table.bbox[1]))
        result.append((
            page_number,
            int(match.group("number")),
            top,
            bottom,
            re.sub(r"\s+", "", label),
        ))
    return result


def _ms_furniture(
    page: fitz.Page,
    tables: list[Any],
) -> tuple[tuple[float, float, float, float], ...]:
    """Running header and footer bands on one mark-scheme page.

    A mark scheme's answers live inside the grid, so anything printed entirely
    above the topmost grid or below the bottommost one is the running header
    ("0610/51 Cambridge IGCSE - Mark Scheme PUBLISHED"), the copyright line, or
    the page number. Mark-scheme regions previously carried no erase boxes at
    all, so all of that appeared in the crop.

    Both the table bboxes and the text blocks used here come back in display
    coordinates via the same rotation mapping the renderer applies.
    """
    if not tables:
        return ()
    matrix = page.rotation_matrix
    top = min(float(table.bbox[1]) for table in tables)
    bottom = max(float(table.bbox[3]) for table in tables)

    boxes: list[tuple[float, float, float, float]] = []
    try:
        blocks = page.get_text("blocks")
    except Exception:
        return ()
    for block in blocks:
        if len(block) < 5 or not str(block[4]).strip():
            continue
        rect = fitz.Rect(block[0], block[1], block[2], block[3]) * matrix
        if rect.is_empty:
            continue
        if rect.y1 <= top or rect.y0 >= bottom:
            boxes.append((rect.x0 - 1, rect.y0 - 1, rect.x1 + 1, rect.y1 + 1))
    return tuple(boxes)


def _label_at(row: list[str | None], question_column: int) -> str:
    """Read the question label from its column.

    Grids are padded with empty spacer columns and the label sometimes lands
    just left of the header cell, so a narrow window around the expected
    column is searched rather than that one cell alone.
    """
    for index in range(max(0, question_column - 1), question_column + 2):
        if index >= len(row):
            break
        text = (row[index] or "").strip().replace("\n", " ")
        if text:
            return text
    return ""


def _row_boxes(table: Any) -> list[tuple[float, float]]:
    """Vertical extent of each row, derived from the table's cell geometry."""
    boxes: list[tuple[float, float]] = []
    for row in table.rows:
        cells = [cell for cell in row.cells if cell]
        if not cells:
            boxes.append((table.bbox[1], table.bbox[3]))
            continue
        boxes.append((
            min(cell[1] for cell in cells),
            max(cell[3] for cell in cells),
        ))
    return boxes


def _spans_from_rows(
    rows: list[tuple[int, int, float, float, str]],
    page_sizes: dict[int, tuple[float, float]],
    pages_with_content: set[int],
    furniture: dict[int, tuple[tuple[float, float, float, float], ...]],
) -> tuple[RootSpan, ...]:
    """Group labelled rows into one span per root question.

    A label owns everything from where it starts to where the next label
    starts, however many pages that crosses.

    This used to stop at the bottom of the label's own page, which quietly
    dropped every continuation page: a mark scheme only prints a label when a
    new question or sub-part begins, so an answer running across a page break
    has no label on the pages it continues onto. On 0610_s15_ms_61 that gave
    Q1 only page 3 and Q2 only page 6, losing pages 4, 5, 7 and 8 entirely.
    Measured over 45 mark schemes, 130 of 375 content pages belonged to no
    region at all.
    """
    grouped: dict[int, list[PageRegion]] = {}
    parts: dict[int, list[str]] = {}
    order: list[int] = []
    last_content_page = max(pages_with_content) if pages_with_content else 0

    for index, (page, root, top, _bottom, label) in enumerate(rows):
        following = rows[index + 1] if index + 1 < len(rows) else None
        if following is not None:
            end_page, end_top = following[0], following[2]
        else:
            # The final label runs to the end of the printed content. Trailing
            # blank or appendix pages are excluded by pages_with_content.
            end_page, end_top = max(page, last_content_page), None

        if root not in grouped:
            grouped[root] = []
            parts[root] = []
            order.append(root)

        for number in range(page, end_page + 1):
            # A blank separator page contributes nothing but a blank strip.
            if number != page and number not in pages_with_content:
                continue
            width, height = page_sizes.get(number, (595.0, 842.0))
            # No fudge below the row boundary: the 2pt that used to be
            # subtracted here pulled the tail of the row above into the crop.
            y0 = max(0.0, top) if number == page else 0.0
            y1 = end_top if (number == end_page and end_top is not None) else height
            if y1 - y0 < _MIN_REGION_HEIGHT:
                continue
            grouped[root].append(PageRegion(
                page=number,
                bbox=(0.0, y0, width, y1),
                erase_bboxes=furniture.get(number, ()),
            ))

        if label not in parts[root]:
            parts[root].append(label)

    return tuple(
        RootSpan(
            root_number=root,
            regions=tuple(_merge_regions(grouped[root])),
            part_labels=tuple(parts[root]),
            confidence=1.0,
        )
        for root in sorted(order)
    )


def _merge_regions(regions: list[PageRegion]) -> list[PageRegion]:
    """Collapse per-row regions into one region per page."""
    by_page: dict[int, list[PageRegion]] = {}
    for region in regions:
        by_page.setdefault(region.page, []).append(region)
    result: list[PageRegion] = []
    for page in sorted(by_page):
        boxes = by_page[page]
        result.append(PageRegion(
            page=page,
            bbox=(
                min(box.bbox[0] for box in boxes),
                min(box.bbox[1] for box in boxes),
                max(box.bbox[2] for box in boxes),
                max(box.bbox[3] for box in boxes),
            ),
            # The merged region covers every row's area, so it must carry every
            # row's erase boxes too; dropping them here left the running header
            # and footer printed inside the crop.
            erase_bboxes=tuple(sorted({
                erase for box in boxes for erase in box.erase_bboxes
            })),
        ))
    return result


def _with_diagnostic(spans: DocumentSpans, diagnostic: dict[str, Any]) -> DocumentSpans:
    return replace(spans, diagnostics=spans.diagnostics + (diagnostic,))
