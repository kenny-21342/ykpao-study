from __future__ import annotations

from dataclasses import dataclass

from .detector import DetectionResult, DetectedRoot
from .evidence import DocumentEvidence, PageEvidence, TextLine, VisualEvidence
from .models import SourceRegion


SOURCE_PADDING_POINTS = 12.0
CLUSTER_GAP_POINTS = 48.0


@dataclass(frozen=True)
class RootRegions:
    root: DetectedRoot
    regions: tuple[SourceRegion, ...]
    essential_visuals: int
    mark_allocations: int
    response_lines_removed: int
    diagnostics: tuple[dict[str, object], ...] = ()


def build_source_regions(
    evidence: DocumentEvidence,
    detection: DetectionResult,
    *,
    dpi: int = 200,
) -> tuple[RootRegions, ...]:
    result: list[RootRegions] = []
    roots = list(detection.roots)
    for index, root in enumerate(roots):
        next_root = roots[index + 1] if index + 1 < len(roots) else None
        regions, visual_count, mark_count, removed_count = _regions_for_root(
            evidence,
            root,
            next_root,
            dpi,
        )
        diagnostics: list[dict[str, object]] = []
        if not regions:
            diagnostics.append({"reason": "missing_source_regions"})
        result.append(RootRegions(
            root=root,
            regions=tuple(regions),
            essential_visuals=visual_count,
            mark_allocations=mark_count,
            response_lines_removed=removed_count,
            diagnostics=tuple(diagnostics),
        ))
    return tuple(result)


def _regions_for_root(
    evidence: DocumentEvidence,
    root: DetectedRoot,
    next_root: DetectedRoot | None,
    dpi: int,
) -> tuple[list[SourceRegion], int, int, int]:
    first_page = root.candidate.page
    last_page = next_root.candidate.page if next_root else len(evidence.pages)
    result: list[SourceRegion] = []
    visual_count = 0
    mark_count = 0
    removed_count = 0

    for page_number in range(first_page, last_page + 1):
        page = evidence.pages[page_number - 1]
        lower = 0.0
        upper = page.height
        if page_number == first_page:
            lower = root.candidate.bbox[1]
            if (
                root.candidate.section_heading_bbox
                and root.candidate.section_heading_bbox[1] < lower
                and root.candidate.section_heading_bbox[1] >= lower - page.height * 0.35
            ):
                lower = root.candidate.section_heading_bbox[1]
        if next_root and page_number == next_root.candidate.page:
            upper = next_root.candidate.bbox[1]
        if upper <= lower:
            continue

        lines = [line for line in page.lines if _inside(line.bbox, lower, upper)]
        # A section heading belongs to the questions under it. Left in, it
        # joined the cluster of whichever root came *before* it — so every
        # History question ended with the next Depth Study's title. The root
        # that owns a heading picks it up through section_heading_bbox above.
        lines = [
            line for line in lines
            if not (next_root is not None and _introduces_next(line, lower))
        ]
        visuals = [visual for visual in page.visuals if _inside(visual.bbox, lower, upper)]
        essential_lines = [line for line in lines if line.essential]
        essential_visuals = [visual for visual in visuals if visual.essential]
        visual_count += len(essential_visuals)
        mark_count += sum(line.has_mark_allocation for line in essential_lines)
        removed_count += sum(len(line.response_erase_bboxes) for line in lines)

        evidence_items = [
            (line.bbox, line.id, "text")
            for line in essential_lines
        ] + [
            (visual.bbox, visual.id, visual.kind)
            for visual in essential_visuals
        ]
        if not evidence_items:
            continue
        clusters = _cluster_vertical(evidence_items)
        for cluster in clusters:
            bbox = _cluster_bbox(cluster, page, lower, upper)
            erase = _erase_boxes(page.lines, page.visuals, bbox)
            result.append(SourceRegion(
                order=len(result),
                page=page_number,
                bbox=bbox,
                source_dpi=dpi,
                evidence=tuple(sorted(item[1] for item in cluster)),
                erase_bboxes=tuple(erase),
            ))
    return result, visual_count, mark_count, removed_count


def _introduces_next(line: TextLine, lower: float) -> bool:
    """A heading sitting below this root's start belongs to the root beneath it.

    History papers put "DEPTH STUDY B: GERMANY, 1918-1945" between two essay
    options. Falling inside the previous root's range, it joined that root's
    cluster, so every question's crop ended with the next section's title.
    evidence.section_label does not recognise these — it is tuned for the IB's
    SIMPLIFIED/TRADITIONAL markers — so headings are identified here by their
    typography instead: bold, capitalised, and not starting with a number.
    """
    if not line.bold or line.bbox[1] <= lower + 1.0:
        return False
    text = line.text.strip()
    if not text or text[0].isdigit():
        return False
    letters = [character for character in text if character.isalpha()]
    if len(letters) < 6:
        return False
    return sum(character.isupper() for character in letters) / len(letters) >= 0.8


def _inside(bbox: tuple[float, float, float, float], lower: float, upper: float) -> bool:
    center = (bbox[1] + bbox[3]) / 2
    return lower <= center < upper


def _cluster_vertical(
    items: list[tuple[tuple[float, float, float, float], str, str]],
) -> list[list[tuple[tuple[float, float, float, float], str, str]]]:
    ordered = sorted(items, key=lambda item: (item[0][1], item[0][0], item[1]))
    clusters: list[list[tuple[tuple[float, float, float, float], str, str]]] = []
    current: list[tuple[tuple[float, float, float, float], str, str]] = []
    current_bottom = 0.0
    for item in ordered:
        top, bottom = item[0][1], item[0][3]
        if current and top - current_bottom > CLUSTER_GAP_POINTS:
            clusters.append(current)
            current = []
        current.append(item)
        current_bottom = max(current_bottom, bottom)
    if current:
        clusters.append(current)
    return clusters


def _cluster_bbox(
    cluster: list[tuple[tuple[float, float, float, float], str, str]],
    page: PageEvidence,
    lower: float,
    upper: float,
) -> tuple[float, float, float, float]:
    x0 = min(item[0][0] for item in cluster)
    y0 = min(item[0][1] for item in cluster)
    x1 = max(item[0][2] for item in cluster)
    y1 = max(item[0][3] for item in cluster)
    return (
        round(max(0.0, x0 - SOURCE_PADDING_POINTS), 3),
        round(max(0.0, lower - _top_padding(page, lower), y0 - _top_padding(page, y0)), 3),
        round(min(page.width, x1 + SOURCE_PADDING_POINTS), 3),
        round(min(page.height, upper - 2.0, y1 + SOURCE_PADDING_POINTS), 3),
    )


def _top_padding(page: PageEvidence, top: float) -> float:
    """How far a region may reach above its own first line.

    The flat 12pt used here crossed into the line above whenever the layout was
    tight, and the crop then opened with a row of clipped descenders — "p y [ ]"
    at the top of every even-numbered History question, where thirteen essay
    options share a page. Padding now stops at whatever is printed above.
    """
    above = [line.bbox[3] for line in page.lines if line.bbox[3] <= top + 0.5]
    if not above:
        return SOURCE_PADDING_POINTS
    gap = top - max(above)
    return max(0.0, min(SOURCE_PADDING_POINTS, gap))


def _erase_boxes(
    lines: list[TextLine],
    visuals: list[VisualEvidence],
    region: tuple[float, float, float, float],
) -> list[tuple[float, float, float, float]]:
    result: list[tuple[float, float, float, float]] = []
    for line in lines:
        for rule in line.response_erase_bboxes:
            if _overlaps(rule, region):
                result.append(rule)
        if line.furniture_reason and _overlaps(line.bbox, region):
            result.append(line.bbox)
    for visual in visuals:
        if not visual.essential and visual.reason in {"response_line", "page_furniture"} and _overlaps(visual.bbox, region):
            x0, y0, x1, y1 = visual.bbox
            result.append((x0 - 1, y0 - 1, x1 + 1, y1 + 1))
    return sorted(set(result))


def _overlaps(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> bool:
    return first[0] < second[2] and first[2] > second[0] and first[1] < second[3] and first[3] > second[1]
