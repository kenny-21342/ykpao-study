from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from hashlib import sha256
import csv
import io
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory
from typing import Iterable

import fitz


_SPACE = re.compile(r"\s+")
_SECTION = re.compile(
    r"^\s*(?:section|part)\s+([A-Z0-9]+)(?:\s*[:.-]\s*[^.]{0,80})?\s*$",
    re.IGNORECASE,
)
_SIMPLIFIED_SECTION = re.compile(
    r"^(?:simplified version|version simplifi(?:ed|ée)|versi[oó]n simplificada)$",
    re.IGNORECASE,
)
_TRADITIONAL_SECTION = re.compile(
    r"^(?:traditional version|version traditionnelle|versi[oó]n tradicional)$",
    re.IGNORECASE,
)
_RESPONSE_RUN = re.compile(r"(?:\.{5,}|_{5,}|(?:\.\s*){5,})")
_ONLY_RESPONSE = re.compile(r"^[\s._·-]{7,}(?:\s*\[\s*\d+\s*\])?$", re.IGNORECASE)
_MARK = re.compile(r"(?:\[\s*\d+\s*\]|\(\s*\d+\s*(?:marks?|points?)\s*\)|\b\d+\s+(?:marks?|points?)\b)", re.IGNORECASE)
_CONTINUED = re.compile(r"\b(?:question\s+)?(\d{1,3})\s+continued\b", re.IGNORECASE)
_CANDIDATE_FIELD = re.compile(
    r"\b(candidate\s+(?:name|number)|centre\s+number|write your name|signature)\b",
    re.IGNORECASE,
)
_COPYRIGHT = re.compile(
    r"(?:©|copyright|uccles|ucles|international baccalaureate organization|"
    r"permission to reproduce|copyright acknowledgements|cambridge assessment is)",
    re.IGNORECASE,
)
_PAGE_FURNITURE = re.compile(
    r"^\s*(?:\[?turn over\]?|blank page|do not write in this area|"
    r"this document has \d+ pages?|page \d+(?: of \d+)?)\s*\.?\s*$",
    re.IGNORECASE,
)
_BLANK_PAGE = re.compile(r"^\s*(?:blank page|page vierge|p[aá]gina en blanco)\s*$", re.IGNORECASE)
_TURN_OVER = re.compile(r"^\s*turn over\b.*$", re.IGNORECASE)
_PAPER_HEADER_CODE = re.compile(
    r"^[A-Z0-9]{1,8}(?:/[A-Z0-9]{1,8}){2,}(?:\s+[A-Z]{2,})?$",
    re.IGNORECASE,
)
# The second alternative used to be case-insensitive, which made "of 5000",
# "than 100", and "a 1.2 V ... 210 mA" all read as paper codes. Any question
# stem that happened to begin a page was then erased whole. Codes are printed
# in capitals, so require them.
_PAPER_CODE = re.compile(
    r"\b(?:\d{4}/\d{1,2}/(?:QP|INSERT|PAPER)|[A-Z]{2,4}\s*\d{3,5})\b",
)
# Furniture is short and label-like. A line carrying sentence punctuation or a
# dozen words is question text that merely landed in the header band.
_PROSE_WORDS = 8
_SENTENCE_END = re.compile(r"[.!?:;](?:\s|$)")
_BARCODE = re.compile(r"^\s*\*?\s*(?:\d\s*){8,}\*?\s*$")


@dataclass(frozen=True)
class TextLine:
    id: str
    page: int
    bbox: tuple[float, float, float, float]
    text: str
    font: str
    size: float
    bold: bool
    source: str = "native"
    furniture_reason: str | None = None
    response_only: bool = False
    response_erase_bboxes: tuple[tuple[float, float, float, float], ...] = ()
    has_mark_allocation: bool = False

    @property
    def essential(self) -> bool:
        return self.furniture_reason is None and (not self.response_only or self.has_mark_allocation)


@dataclass(frozen=True)
class VisualEvidence:
    id: str
    page: int
    bbox: tuple[float, float, float, float]
    kind: str
    essential: bool
    reason: str | None = None


@dataclass
class PageEvidence:
    number: int
    width: float
    height: float
    lines: list[TextLine] = field(default_factory=list)
    visuals: list[VisualEvidence] = field(default_factory=list)
    used_ocr: bool = False

    @property
    def section_headings(self) -> list[TextLine]:
        return [line for line in self.lines if section_label(line) and line.furniture_reason is None]

    @property
    def continued_roots(self) -> list[tuple[int, TextLine]]:
        result: list[tuple[int, TextLine]] = []
        for line in self.lines:
            match = _CONTINUED.search(line.text)
            if match:
                result.append((int(match.group(1)), line))
        return result


@dataclass(frozen=True)
class DocumentEvidence:
    pages: tuple[PageEvidence, ...]
    source_sha256: str
    native_text_characters: int
    used_ocr: bool
    unsupported_scan_language: bool = False


def file_sha256(path: Path) -> str:
    hasher = sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


def extract_document_evidence(
    path: Path,
    *,
    language: str = "en",
    tesseract: str = "tesseract",
    temp_root: Path | None = None,
) -> DocumentEvidence:
    digest = file_sha256(path)
    pages: list[PageEvidence] = []
    native_characters = 0
    with fitz.open(path) as document:
        for page_index, page in enumerate(document):
            page_evidence = _native_page(page, page_index + 1, digest)
            native_characters += sum(len(item.text) for item in page_evidence.lines)
            pages.append(page_evidence)

        _mark_repeated_furniture(pages)
        textless = native_characters < max(40, document.page_count * 4)
        unsupported = textless and language.lower() not in {"en", "eng"}
        if textless and not unsupported:
            for page_index, page in enumerate(document):
                if _page_needs_ocr(pages[page_index]):
                    ocr_lines = _ocr_page(
                        page,
                        page_index + 1,
                        digest,
                        tesseract=tesseract,
                        temp_root=temp_root,
                    )
                    if ocr_lines:
                        pages[page_index].lines = ocr_lines
                        pages[page_index].used_ocr = True
            _mark_repeated_furniture(pages)

    return DocumentEvidence(
        pages=tuple(pages),
        source_sha256=digest,
        native_text_characters=native_characters,
        used_ocr=any(page.used_ocr for page in pages),
        unsupported_scan_language=unsupported,
    )


def section_label(line: TextLine) -> str | None:
    match = _SECTION.match(line.text)
    if match:
        return match.group(1).upper()
    text = line.text.strip()
    if _SIMPLIFIED_SECTION.fullmatch(text):
        return "SIMPLIFIED"
    if _TRADITIONAL_SECTION.fullmatch(text):
        return "TRADITIONAL"
    return None


def _native_page(page: fitz.Page, page_number: int, digest: str) -> PageEvidence:
    lines: list[TextLine] = []
    # "rawdict" carries per-character boxes. Estimating the dotted rule's
    # position from Helvetica metrics instead used to overshoot into the words
    # on either side of it, and swallowed the "[2]" that follows many rules.
    raw = page.get_text("rawdict", sort=True)
    image_blocks: list[tuple[float, float, float, float]] = []
    for block in raw.get("blocks", []):
        if block.get("type") == 1:
            image_blocks.append(_bbox(block.get("bbox", (0, 0, 0, 0))))
            continue
        if block.get("type") != 0:
            continue
        for raw_line in block.get("lines", []):
            spans = [span for span in raw_line.get("spans", []) if _clean_text(_span_text(span))]
            if not spans:
                continue
            text = _clean_text(" ".join(_span_text(span) for span in spans))
            bbox = _bbox(raw_line.get("bbox", (0, 0, 0, 0)))
            font = ",".join(sorted({str(span.get("font", "")) for span in spans}))
            size = max(float(span.get("size", 0) or 0) for span in spans)
            bold = any(
                "bold" in str(span.get("font", "")).lower() or int(span.get("flags", 0)) & 16
                for span in spans
            )
            lines.append(_make_line(
                digest, page_number, bbox, text, font, size, bold, "native",
                rule_bboxes=_rule_bboxes(spans),
            ))

    drawings = list(page.get_drawings())
    blank_page = any(_BLANK_PAGE.fullmatch(_span_text(span).strip()) for block in raw.get("blocks", [])
                     if block.get("type") == 0 for raw_line in block.get("lines", [])
                     for span in raw_line.get("spans", []))
    visuals = _visual_evidence(page, page_number, digest, drawings, image_blocks, blank_page=blank_page)
    return PageEvidence(
        number=page_number,
        width=float(page.rect.width),
        height=float(page.rect.height),
        lines=lines,
        visuals=visuals,
    )


def _visual_evidence(
    page: fitz.Page,
    page_number: int,
    digest: str,
    drawings: list[dict],
    images: list[tuple[float, float, float, float]],
    *,
    blank_page: bool = False,
) -> list[VisualEvidence]:
    raw: list[tuple[tuple[float, float, float, float], int]] = []
    for drawing in drawings:
        bbox = _bbox(drawing.get("rect", (0, 0, 0, 0)))
        raw.append((bbox, len(drawing.get("items", []))))

    result: list[VisualEvidence] = []
    for index, (bbox, item_count) in enumerate(raw):
        x0, y0, x1, y1 = bbox
        width, height = x1 - x0, y1 - y0
        reason: str | None = None
        if blank_page:
            reason = "page_furniture"
        elif y1 < page.rect.height * 0.035 or y0 > page.rect.height * 0.94:
            reason = "page_furniture"
        elif height <= 1.6 and width > page.rect.width * 0.32 and item_count <= 2:
            intersects_vertical = any(
                _vertical_intersection(bbox, other)
                for other, _other_count in raw
                if other != bbox
            )
            if not intersects_vertical:
                reason = "response_line"
        result.append(VisualEvidence(
            id=_evidence_id(digest, page_number, f"drawing-{index}", bbox),
            page=page_number,
            bbox=bbox,
            kind="vector",
            essential=reason is None,
            reason=reason,
        ))

    for index, bbox in enumerate(images):
        x0, y0, x1, y1 = bbox
        area = max(0.0, x1 - x0) * max(0.0, y1 - y0)
        reason = None if area >= 100 else "tiny_image"
        result.append(VisualEvidence(
            id=_evidence_id(digest, page_number, f"image-{index}", bbox),
            page=page_number,
            bbox=bbox,
            kind="embedded_image",
            essential=reason is None,
            reason=reason,
        ))
    return result


def _make_line(
    digest: str,
    page: int,
    bbox: tuple[float, float, float, float],
    text: str,
    font: str,
    size: float,
    bold: bool,
    source: str,
    rule_bboxes: tuple[tuple[float, float, float, float], ...] | None = None,
) -> TextLine:
    response_match = _RESPONSE_RUN.search(text)
    response_only = bool(_ONLY_RESPONSE.fullmatch(text))
    if rule_bboxes is not None:
        erase = rule_bboxes
    elif response_match:
        # OCR lines have no glyph boxes, so the estimate is all there is.
        estimated = _response_erase_bbox(text, bbox, response_match, size)
        erase = (estimated,) if estimated else ()
    else:
        erase = ()
    return TextLine(
        id=_evidence_id(digest, page, text, bbox),
        page=page,
        bbox=bbox,
        text=text,
        font=font,
        size=round(size, 3),
        bold=bold,
        source=source,
        response_only=response_only,
        response_erase_bboxes=erase,
        has_mark_allocation=bool(_MARK.search(text)),
    )


def _mark_repeated_furniture(pages: list[PageEvidence]) -> None:
    if not pages:
        return
    occurrences: Counter[str] = Counter()
    per_page: list[set[str]] = []
    for page in pages:
        keys = {
            _repeat_key(line.text)
            for line in page.lines
            if line.bbox[1] < page.height * 0.11 or line.bbox[3] > page.height * 0.89
            if not line.text.strip().isdigit()
            if not line.has_mark_allocation
        }
        per_page.append(keys)
        occurrences.update(keys)
    threshold = max(2, (len(pages) + 1) // 2)
    repeated = {key for key, count in occurrences.items() if count >= threshold and len(key) >= 2}

    for page, keys in zip(pages, per_page):
        copyright_start = min(
            (line.bbox[1] for line in page.lines if _COPYRIGHT.search(line.text) and line.bbox[1] > page.height * 0.65),
            default=None,
        )
        updated: list[TextLine] = []
        for line in page.lines:
            reason = _furniture_reason(line, page, repeated, copyright_start)
            updated.append(TextLine(**{**line.__dict__, "furniture_reason": reason}))
        page.lines = updated


def _furniture_reason(
    line: TextLine,
    page: PageEvidence,
    repeated: set[str],
    copyright_start: float | None,
) -> str | None:
    text = line.text.strip()
    if copyright_start is not None and line.bbox[1] >= copyright_start:
        return "copyright_furniture"
    if _repeat_key(text) in repeated:
        return "repeated_header_footer"
    if _CANDIDATE_FIELD.search(text):
        return "candidate_field"
    if _BLANK_PAGE.fullmatch(text):
        return "page_furniture"
    if _BARCODE.fullmatch(text.replace(" ", "")):
        return "barcode"
    if _COPYRIGHT.search(text) and (line.bbox[1] < page.height * 0.16 or line.bbox[3] > page.height * 0.82):
        return "copyright_furniture"
    if _PAGE_FURNITURE.fullmatch(text) and (
        line.bbox[1] < page.height * 0.13 or line.bbox[3] > page.height * 0.82
    ):
        return "page_furniture"
    if _TURN_OVER.fullmatch(text) and line.bbox[3] > page.height * 0.72:
        return "page_furniture"
    if text.isdigit() and (
        line.bbox[1] < page.height * 0.1 or line.bbox[3] > page.height * 0.9
    ) and page.width * 0.38 <= (line.bbox[0] + line.bbox[2]) / 2 <= page.width * 0.62:
        return "page_number"
    if _looks_like_prose(text):
        return None
    if _PAPER_CODE.search(text) and (line.bbox[1] < page.height * 0.1 or line.bbox[3] > page.height * 0.9):
        return "paper_code"
    if _PAPER_HEADER_CODE.fullmatch(text) and line.bbox[1] < page.height * 0.13:
        return "paper_code"
    return None


def _looks_like_prose(text: str) -> bool:
    """True when a line is question text, whatever band of the page it sits in.

    Only the position-based rules below consult this. Copyright notices,
    candidate fields, and repeated headers are identified by their content and
    stay furniture however long they run.
    """
    return len(text.split()) >= _PROSE_WORDS or bool(_SENTENCE_END.search(text))


def _ocr_page(
    page: fitz.Page,
    page_number: int,
    digest: str,
    *,
    tesseract: str,
    temp_root: Path | None,
) -> list[TextLine]:
    dpi = 150
    with TemporaryDirectory(dir=temp_root) as directory:
        image_path = Path(directory) / f"page-{page_number}.png"
        page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False, colorspace=fitz.csGRAY).save(image_path)
        completed = subprocess.run(
            [tesseract, str(image_path), "stdout", "-l", "eng", "--psm", "6", "tsv"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    if completed.returncode != 0:
        return []
    rows = csv.DictReader(io.StringIO(completed.stdout), delimiter="\t")
    grouped: dict[tuple[str, str, str], list[dict[str, str]]] = {}
    for row in rows:
        text = _clean_text(row.get("text", ""))
        if not text:
            continue
        confidence = float(row.get("conf", "-1") or -1)
        if confidence < 20:
            continue
        key = (row.get("block_num", "0"), row.get("par_num", "0"), row.get("line_num", "0"))
        grouped.setdefault(key, []).append(row)

    scale = 72 / dpi
    result: list[TextLine] = []
    for words in grouped.values():
        text = _clean_text(" ".join(word.get("text", "") for word in words))
        left = min(int(word["left"]) for word in words) * scale
        top = min(int(word["top"]) for word in words) * scale
        right = max(int(word["left"]) + int(word["width"]) for word in words) * scale
        bottom = max(int(word["top"]) + int(word["height"]) for word in words) * scale
        bbox = (left, top, right, bottom)
        result.append(_make_line(
            digest, page_number, bbox, text, "tesseract", bottom - top, False, "ocr",
            rule_bboxes=_rule_bboxes_from_words(words, scale),
        ))
    return sorted(result, key=lambda item: (item.bbox[1], item.bbox[0]))


def _rule_bboxes_from_words(
    words: list[dict[str, str]],
    scale: float,
) -> tuple[tuple[float, float, float, float], ...] | None:
    """Answer-rule boxes on an OCR'd line, from Tesseract's own word boxes.

    Scanned papers used to be the one place still measuring the rule against
    Helvetica metrics — the estimate that clipped "minutes" down to "nutes" on
    native pages. Tesseract reports a box per word, and a rule OCRs as a word of
    dots, so the same measured approach works here.

    Returns ``None`` when no word on the line reads as a rule, which leaves the
    caller free to fall back: OCR frequently mangles a dotted rule into
    something else entirely, and guessing beats erasing the wrong thing.
    """
    boxes: list[tuple[float, float, float, float]] = []
    for word in words:
        text = str(word.get("text", ""))
        if len(text) < _MIN_RULE_CHARS or not RULE_ONLY_WORD.fullmatch(text):
            continue
        left = int(word["left"]) * scale
        top = int(word["top"]) * scale
        boxes.append((
            left,
            top,
            left + int(word["width"]) * scale,
            top + int(word["height"]) * scale,
        ))
    return tuple(boxes) or None


def _page_needs_ocr(page: PageEvidence) -> bool:
    native = sum(len(line.text) for line in page.lines if line.furniture_reason is None)
    return native < 8 and bool(page.visuals or page.lines)


def _response_erase_bbox(
    text: str,
    bbox: tuple[float, float, float, float],
    match: re.Match[str] | None,
    font_size: float,
) -> tuple[float, float, float, float] | None:
    if not match or not text:
        return None
    x0, y0, x1, y1 = bbox
    prefix = text[:match.start()]
    suffix = text[match.end():]
    prefix_width = fitz.get_text_length(prefix, fontname="helv", fontsize=max(font_size, 1))
    suffix_width = fitz.get_text_length(suffix, fontname="helv", fontsize=max(font_size, 1))
    start = min(x1, x0 + prefix_width)
    end = max(x0, x1 - suffix_width)
    return (max(x0, start - 0.5), y0 - 0.5, min(x1, end + 0.5), y1 + 0.5)


_RULE_CHARS = frozenset(".·_…\u2024\u2027")
_MIN_RULE_CHARS = 5
# A whole OCR word that is nothing but rule characters.
RULE_ONLY_WORD = re.compile(r"[.\u00b7_\u2026\u2024\u2027]+")


def _span_text(span: dict) -> str:
    """Text of a rawdict span, which stores characters rather than a string."""
    chars = span.get("chars")
    if chars is None:
        return str(span.get("text", ""))
    return "".join(str(char.get("c", "")) for char in chars)


def _rule_bboxes(spans: list[dict]) -> tuple[tuple[float, float, float, float], ...]:
    """Bounding boxes of the answer rules in one line, from real glyph boxes.

    A run ends at the first character that is not a rule dot, so a mark
    allocation or a unit printed at the end of the rule ("......[2]",
    "......°C") keeps its own space and survives the erase.
    """
    runs: list[list[tuple[float, float, float, float]]] = []
    current: list[tuple[float, float, float, float]] = []
    dots = 0
    for span in spans:
        for char in span.get("chars", []):
            value = str(char.get("c", ""))
            box = _bbox(char.get("bbox", (0, 0, 0, 0)))
            if value in _RULE_CHARS:
                current.append(box)
                dots += 1
                continue
            if value.isspace() and current:
                # A space inside a spaced-out rule ("​. . . . .") does not end it,
                # but it must not extend the box either.
                continue
            if dots >= _MIN_RULE_CHARS:
                runs.append(current)
            current, dots = [], 0
    if dots >= _MIN_RULE_CHARS:
        runs.append(current)

    result = []
    for run in runs:
        x0 = min(box[0] for box in run)
        y0 = min(box[1] for box in run)
        x1 = max(box[2] for box in run)
        y1 = max(box[3] for box in run)
        # No horizontal padding: the glyph boxes already include side bearings,
        # and widening by even half a point clips the "[2]" that abuts the rule.
        result.append((x0, y0 - 0.5, x1, y1 + 0.5))
    return tuple(result)


def _repeat_key(text: str) -> str:
    normalized = re.sub(r"\d+", "#", text.lower())
    return _SPACE.sub(" ", normalized).strip(" .-")


def _vertical_intersection(
    horizontal: tuple[float, float, float, float],
    other: tuple[float, float, float, float],
) -> bool:
    hx0, hy0, hx1, hy1 = horizontal
    ox0, oy0, ox1, oy1 = other
    other_width, other_height = ox1 - ox0, oy1 - oy0
    if other_height <= max(3, other_width * 2):
        return False
    y = (hy0 + hy1) / 2
    return oy0 - 2 <= y <= oy1 + 2 and hx0 - 2 <= (ox0 + ox1) / 2 <= hx1 + 2


def _clean_text(value: str) -> str:
    return _SPACE.sub(" ", str(value).replace("\u00a0", " ")).strip()


def _bbox(value: Iterable[float] | fitz.Rect) -> tuple[float, float, float, float]:
    numbers = list(value)
    return tuple(round(float(number), 3) for number in numbers[:4])  # type: ignore[return-value]


def _evidence_id(
    digest: str,
    page: int,
    identity: str,
    bbox: tuple[float, float, float, float],
) -> str:
    payload = f"{digest}:{page}:{identity}:{','.join(f'{item:.3f}' for item in bbox)}"
    return f"qie_{sha256(payload.encode('utf-8')).hexdigest()[:20]}"
