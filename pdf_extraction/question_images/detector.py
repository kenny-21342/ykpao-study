from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median
import re

from .evidence import DocumentEvidence, PageEvidence, TextLine, section_label


_ROOT = re.compile(
    r"^\s*(?:(?:question|quest[aã]o|pregunta)\s+)?(?P<number>\d{1,3})"
    r"(?:\s*[.)])?(?:\s+|$)(?P<tail>.*)$",
    re.IGNORECASE,
)
_SUBPART = re.compile(r"^\s*\(?[a-zivx]{1,5}\)\s+", re.IGNORECASE)
_BAD_TAIL = re.compile(
    r"^(?:(?:hours?|minutes?|seconds?|s|cm|mm|m|kg|marks?|points?)\b|of\s+\d)",
    re.IGNORECASE,
)
_PROMPT_CUE = re.compile(
    r"\b(?:calculate|determine|find|state|explain|describe|show|prove|write|give|"
    r"which|what|why|how|consider|the|a|an|in this|use|read|answer|evaluate|discuss|"
    r"outline|identify|compare|analyse|analyze|draw|complete|solve|express)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class RootCandidate:
    number: int
    page: int
    bbox: tuple[float, float, float, float]
    line_id: str
    text: str
    score: float
    signals: tuple[str, ...]
    section: str
    section_index: int
    section_heading_id: str | None = None
    section_heading_bbox: tuple[float, float, float, float] | None = None
    # The page that bbox is on. `section_heading` is carried across pages by
    # the scan loop, so without this its y-coordinate was read against whatever
    # page a later root happened to sit on -- on 0455_s17_qp_23 every root from
    # page 3 onward carried a heading at y=344.5 from page 3, and question 6
    # extended its crop up to that coordinate on page 4, starting 90pt inside
    # question 5.
    section_heading_page: int | None = None
    source: str = "native"

    @property
    def position(self) -> tuple[int, float, float]:
        return (self.page, self.bbox[1], self.bbox[0])


@dataclass
class DetectedRoot:
    candidate: RootCandidate
    diagnostics: list[dict[str, object]] = field(default_factory=list)
    sequence_margin: float = 99.0

    @property
    def number(self) -> int:
        return self.candidate.number

    @property
    def quarantined(self) -> bool:
        return bool(self.diagnostics)


@dataclass(frozen=True)
class DetectionResult:
    roots: tuple[DetectedRoot, ...]
    candidates: tuple[RootCandidate, ...]
    diagnostics: tuple[dict[str, object], ...] = ()


def detect_roots(evidence: DocumentEvidence) -> DetectionResult:
    if evidence.unsupported_scan_language:
        return DetectionResult((), (), ({"reason": "unsupported_scanned_language"},))

    candidates = tuple(_root_candidates(evidence))
    if not candidates:
        reason = "ocr_failed" if evidence.used_ocr else "no_root_candidates"
        return DetectionResult((), candidates, ({"reason": reason},))

    selected: list[RootCandidate] = []
    for section_index in sorted({item.section_index for item in candidates}):
        section_candidates = [item for item in candidates if item.section_index == section_index]
        selected.extend(_decode_section(section_candidates))
    selected.sort(key=lambda item: item.position)
    roots = [DetectedRoot(item) for item in selected]
    _annotate_ambiguity(roots, candidates, evidence)
    return DetectionResult(tuple(roots), candidates)


def _root_candidates(evidence: DocumentEvidence) -> list[RootCandidate]:
    candidates: list[RootCandidate] = []
    section_index = 0
    section_name = "default"
    section_heading: TextLine | None = None
    section_heading_page: int | None = None
    sizes = [
        line.size
        for page in evidence.pages
        for line in page.lines
        if line.furniture_reason is None and line.size > 0
    ]
    median_size = median(sizes) if sizes else 10.0

    for page in evidence.pages:
        lines = sorted(page.lines, key=lambda item: (item.bbox[1], item.bbox[0]))
        for line_index, line in enumerate(lines):
            label = section_label(line)
            explicit_heading = bool(
                label
                and not label.isdigit()
                and (
                    label in {"SIMPLIFIED", "TRADITIONAL"}
                    or line.bold
                    or line.text.strip().isupper()
                )
            )
            if label and explicit_heading:
                if label != section_name:
                    section_index += 1
                    section_name = label
                    section_heading = line
                    section_heading_page = page.number
                continue
            match = _ROOT.match(line.text)
            if not match or line.furniture_reason is not None:
                continue
            number = int(match.group("number"))
            tail = match.group("tail").strip()
            neighbor = _same_row_neighbor(lines, line_index, line)
            score, signals = _score_candidate(page, line, number, tail, neighbor, median_size)
            if score < 2.4:
                continue
            candidate_bbox = _union_bbox(line.bbox, neighbor.bbox) if neighbor else line.bbox
            candidates.append(RootCandidate(
                number=number,
                page=page.number,
                bbox=candidate_bbox,
                line_id=line.id,
                text=line.text,
                score=round(score, 3),
                signals=tuple(signals),
                section=section_name,
                section_index=section_index,
                section_heading_id=section_heading.id if section_heading else None,
                section_heading_bbox=section_heading.bbox if section_heading else None,
                section_heading_page=section_heading_page,
                source=line.source,
            ))
    return _typography_filter(candidates)


def _typography_filter(candidates: list[RootCandidate]) -> list[RootCandidate]:
    result: list[RootCandidate] = []
    for section_index in sorted({item.section_index for item in candidates}):
        section = [item for item in candidates if item.section_index == section_index]
        bold_numbers = {
            item.number for item in section
            if "bold" in item.signals and item.source != "ocr"
        }
        if len(bold_numbers) >= 2:
            result.extend(
                item for item in section
                if "bold" in item.signals or item.source == "ocr"
            )
        else:
            result.extend(section)
    return sorted(result, key=lambda item: item.position)


def _score_candidate(
    page: PageEvidence,
    line: TextLine,
    number: int,
    tail: str,
    neighbor: TextLine | None,
    median_size: float,
) -> tuple[float, list[str]]:
    score = 0.0
    signals: list[str] = []
    x_ratio = line.bbox[0] / max(1, page.width)
    if x_ratio <= 0.12:
        score += 2.3
        signals.append("left_margin_strong")
    elif x_ratio <= 0.2:
        score += 1.4
        signals.append("left_margin")
    elif x_ratio <= 0.27:
        score += 0.4
        signals.append("left_of_body")
    else:
        score -= 2.5
        signals.append("not_left_margin")

    y_ratio = line.bbox[1] / max(1, page.height)
    if 0.035 <= y_ratio <= 0.9:
        score += 0.5
    else:
        score -= 1.5
        signals.append("margin_vertical")

    context = tail or (neighbor.text if neighbor else "")
    punctuated = bool(re.match(
        rf"^\s*(?:(?:question|quest[aã]o|pregunta)\s+)?{number}\s*[.)]",
        line.text,
        re.IGNORECASE,
    ))
    if len(context) >= 8:
        score += 1.2
        signals.append("prompt_context")
    if _PROMPT_CUE.search(context):
        score += 0.8
        signals.append("prompt_language")
    if not tail and neighbor:
        score += 0.7
        signals.append("separate_number_glyph")
        if x_ratio > 0.145 and not line.bold:
            score -= 4.0
            signals.append("indented_numeric_glyph")
        if x_ratio > 0.09 and not punctuated and not line.bold and not _PROMPT_CUE.search(context):
            score -= 3.5
            signals.append("unbolded_line_number")
    if tail and not punctuated and not _PROMPT_CUE.search(context):
        score -= 1.0
        signals.append("unpunctuated_numeric_sentence")
    if line.bold:
        score += 0.25
        signals.append("bold")
    if line.size >= median_size * 0.9:
        score += 0.25
        signals.append("body_typography")
    if line.has_mark_allocation:
        score -= 2.0
        signals.append("mark_allocation_line")
    if line.response_erase_bboxes:
        score -= 3.5
        signals.append("response_line_number")
    if context[:1].islower() and _BAD_TAIL.match(context):
        score -= 2.7
        signals.append("measurement_or_duration")
    if _SUBPART.match(line.text):
        score -= 4.0
        signals.append("subpart")
    if number > 60:
        score -= 1.5
        signals.append("large_number")
    if re.match(r"^\d+(?:\.\d+)", line.text):
        score -= 2.0
        signals.append("decimal")
    return score, signals


def _same_row_neighbor(lines: list[TextLine], index: int, line: TextLine) -> TextLine | None:
    center = (line.bbox[1] + line.bbox[3]) / 2
    best: TextLine | None = None
    for candidate in lines:
        if candidate.id == line.id or candidate.furniture_reason is not None:
            continue
        candidate_center = (candidate.bbox[1] + candidate.bbox[3]) / 2
        if abs(candidate_center - center) <= max(5, line.bbox[3] - line.bbox[1]) and candidate.bbox[0] > line.bbox[0]:
            if best is None or candidate.bbox[0] < best.bbox[0]:
                best = candidate
    return best


def _decode_section(candidates: list[RootCandidate]) -> list[RootCandidate]:
    if not candidates:
        return []
    ordered = sorted(candidates, key=lambda item: item.position)
    scores: list[float] = []
    previous: list[int | None] = []
    for index, candidate in enumerate(ordered):
        start = candidate.score + (2.0 if candidate.number == 1 else -min(3.0, candidate.number * 0.25))
        best_score = start
        best_previous: int | None = None
        for prior_index in range(index):
            prior = ordered[prior_index]
            transition = _transition_score(prior.number, candidate.number)
            combined = scores[prior_index] + candidate.score + transition
            if combined > best_score:
                best_score = combined
                best_previous = prior_index
        scores.append(best_score)
        previous.append(best_previous)

    endpoint = max(range(len(ordered)), key=lambda item: scores[item])
    path: list[RootCandidate] = []
    cursor: int | None = endpoint
    while cursor is not None:
        path.append(ordered[cursor])
        cursor = previous[cursor]
    path.reverse()
    return path


def _transition_score(previous: int, current: int) -> float:
    difference = current - previous
    if difference == 1:
        return 2.4
    if difference > 1:
        return -1.8 * (difference - 1)
    if difference == 0:
        return -5.0
    return -7.0 - abs(difference) * 0.5


def _annotate_ambiguity(
    roots: list[DetectedRoot],
    candidates: tuple[RootCandidate, ...],
    evidence: DocumentEvidence,
) -> None:
    for index, root in enumerate(roots):
        candidate = root.candidate
        alternatives = [
            item for item in candidates
            if item.section_index == candidate.section_index
            and item.number == candidate.number
            and item.line_id != candidate.line_id
        ]
        if alternatives:
            best_alternative = max(alternatives, key=lambda item: item.score)
            margin = candidate.score - best_alternative.score
            root.sequence_margin = round(margin, 3)
            if margin <= 0.35:
                root.diagnostics.append({
                    "reason": "tied_interpretation",
                    "alternativePage": best_alternative.page,
                    "alternativeBbox": list(best_alternative.bbox),
                    "scoreMargin": round(margin, 3),
                })

        if candidate.score < 3.0:
            root.diagnostics.append({"reason": "low_candidate_confidence", "score": candidate.score})

        if index:
            prior = roots[index - 1]
            if prior.candidate.section_index == candidate.section_index:
                difference = candidate.number - prior.number
                if difference > 1:
                    diagnostic = {
                        "reason": "sequence_gap",
                        "after": prior.number,
                        "before": candidate.number,
                    }
                    prior.diagnostics.append(diagnostic)
                elif difference <= 0:
                    root.diagnostics.append({
                        "reason": "non_monotonic_sequence",
                        "previous": prior.number,
                        "current": candidate.number,
                    })
                if candidate.page == prior.candidate.page and candidate.bbox[1] - prior.candidate.bbox[1] <= 24:
                    prior.diagnostics.append({"reason": "adjacent_root_overlap", "with": candidate.number})
                    root.diagnostics.append({"reason": "adjacent_root_overlap", "with": prior.number})

    for page in evidence.pages:
        for continued_number, line in page.continued_roots:
            owner = _root_at_position(roots, page.number, line.bbox[1])
            if owner is None or owner.number != continued_number:
                target = owner or _nearest_root(roots, page.number)
                if target:
                    target.diagnostics.append({
                        "reason": "missing_continuation",
                        "page": page.number,
                        "continuedRoot": continued_number,
                        "bbox": list(line.bbox),
                    })


def _root_at_position(roots: list[DetectedRoot], page: int, y: float) -> DetectedRoot | None:
    owner: DetectedRoot | None = None
    for root in roots:
        if root.candidate.page < page or (root.candidate.page == page and root.candidate.bbox[1] <= y):
            owner = root
        else:
            break
    return owner


def _nearest_root(roots: list[DetectedRoot], page: int) -> DetectedRoot | None:
    return min(roots, key=lambda item: abs(item.candidate.page - page), default=None)


def _union_bbox(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    return (
        min(first[0], second[0]),
        min(first[1], second[1]),
        max(first[2], second[2]),
        max(first[3], second[3]),
    )
