"""Stage 2 — rendering and figure assets.

For each root span from stage 1 this module:

1.  Renders the span's own rectangle as a 200 DPI strip. The strip is the
    model input *and* the permanent per-question screenshot, so the interface
    can always show the original even when transcription is poor.
2.  Crops figures and tables that fall inside the span into content-addressed
    PNGs, deduplicated by sha256.
3.  Returns a figure inventory (``fig1``, ``fig2``, …) for the prompt. The
    model may only reference these ids, so it cannot invent an asset.

Two things here were wrong in the first cut and are worth stating plainly,
because both silently cost money:

*   Strips were rendered at *full page height* regardless of how much of the
    page the question occupied. A question filling an eighth of a page still
    sent the whole page, multiplying vision tokens for no information gain —
    exactly the waste v4 exists to avoid. Strips now cover the span rectangle
    plus a small margin.
*   ``erase_bboxes`` from stage 1 were ignored, so dotted answer rules and
    barcodes reached the model anyway. They are now painted out before render.

Nothing here calls a model or a network.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import fitz

from .spans import DocumentSpans, PageRegion, RENDER_DPI, RootSpan

# Padding around a span rectangle, in PDF points. Enough to catch a figure
# caption or a marks bracket sitting just outside the detected bounds.
STRIP_MARGIN_X = 12.0
STRIP_MARGIN_TOP = 8.0
STRIP_MARGIN_BOTTOM = 12.0

# A crop smaller than this is not a diagram. Mathematical typesetting draws
# large brackets, radicals, and fraction bars as vector paths, and at the
# original 12pt/220pt² thresholds those flooded the inventory with 40px
# slivers — 24 of them on a single mark scheme. An exam diagram is at least
# roughly half an inch on its short side.
MIN_FIGURE_AREA = 2500.0
MIN_FIGURE_SIDE = 30.0

# Two candidate rectangles overlapping more than this are the same figure.
FIGURE_DEDUP_IOU = 0.55

# PyMuPDF reports every vector path separately, so one circuit diagram arrives
# as dozens of unrelated rectangles — the arrowheads, the terminal circles, each
# wire. Taken individually they are too small to be figures and get discarded,
# losing the diagram entirely. Paths whose bounding boxes come within this many
# points of each other are treated as one drawing.
FIGURE_CLUSTER_GAP = 14.0

# Rules and borders span a whole column and would merge every cluster on the
# page into a single blob, so they are excluded before clustering.
RULE_MAX_THICKNESS = 2.5
RULE_MIN_LENGTH = 90.0

# How far outside a diagram to look for its text labels, and how much the
# diagram may grow to absorb them (as a fraction of its own size per side).
FIGURE_LABEL_GAP = 14.0
MAX_LABEL_GROWTH = 0.45

# Longest edge, in pixels, of an image sent to the model. Mark-scheme spans run
# the full width of a landscape page, which at 200 DPI is over 2000px — beyond
# what the vision model resolves, so the extra pixels cost upload and tokens
# while adding nothing. Capping the long edge keeps text comfortably legible
# (the effective DPI stays above 150) and cuts mark-scheme payloads sharply.
MAX_STRIP_EDGE = 1600
MAX_FIGURE_EDGE = 1800


def _display(page: fitz.Page, rect: Any) -> fitz.Rect:
    """Map a rect into the space ``page.rect`` and ``get_pixmap`` work in.

    On a rotated page these are not the same thing. ``find_tables`` reports
    display coordinates, but ``get_text``, ``get_drawings`` and
    ``get_image_rects`` all report the unrotated page. Mark schemes are landscape
    scans of a portrait page — 43 of 80 sampled carry ``/Rotate 90`` — so mixing
    the two silently cropped the Marks column off the right of every strip.

    ``rotation_matrix`` is the identity on an unrotated page, so this is a no-op
    everywhere else.
    """
    return fitz.Rect(rect) * page.rotation_matrix


@dataclass(frozen=True)
class AssetRecord:
    """One stored image: a figure, a table, or a question screenshot."""

    sha256: str
    kind: str  # figure | table | screenshot
    relative_path: str  # assets/sha256/<ab>/<sha>.png
    absolute_path: str
    width: int
    height: int
    byte_size: int
    source_page: int
    bbox: tuple[float, float, float, float]
    source_dpi: int = RENDER_DPI

    def to_dict(self) -> dict[str, Any]:
        return {
            "sha256": self.sha256,
            "kind": self.kind,
            "relative_path": self.relative_path,
            "width": self.width,
            "height": self.height,
            "byte_size": self.byte_size,
            "source_page": self.source_page,
            "bbox": [round(value, 3) for value in self.bbox],
            "source_dpi": self.source_dpi,
        }


@dataclass(frozen=True)
class StripRecord:
    """One rendered strip covering part of a root question."""

    page: int
    bbox: tuple[float, float, float, float]
    sha256: str
    relative_path: str
    absolute_path: str

    @property
    def path(self) -> Path:
        return Path(self.absolute_path)


@dataclass(frozen=True)
class RenderedSpan:
    """Rendering output for one root question."""

    root_number: int
    strips: tuple[StripRecord, ...]
    figures: tuple[dict[str, Any], ...] = ()
    page_start: int = 0
    page_end: int = 0

    @property
    def screenshot_sha256(self) -> str | None:
        """The first strip doubles as the question's screenshot fallback."""
        return self.strips[0].sha256 if self.strips else None

    @property
    def image_paths(self) -> list[Path]:
        return [strip.path for strip in self.strips]

    def to_dict(self) -> dict[str, Any]:
        return {
            "root_number": self.root_number,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "strips": [strip.relative_path for strip in self.strips],
            "screenshot_sha256": self.screenshot_sha256,
            "figures": list(self.figures),
        }


@dataclass(frozen=True)
class RenderOutput:
    """Rendering output for one document."""

    source_path: str
    source_sha256: str
    doc_type: str
    rendered_spans: tuple[RenderedSpan, ...] = ()
    assets: tuple[AssetRecord, ...] = ()

    def span_for(self, root_number: int) -> RenderedSpan | None:
        for span in self.rendered_spans:
            if span.root_number == root_number:
                return span
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_path": self.source_path,
            "source_sha256": self.source_sha256,
            "doc_type": self.doc_type,
            "rendered_spans": [span.to_dict() for span in self.rendered_spans],
            "assets": [asset.to_dict() for asset in self.assets],
        }


def render_strips_and_assets(
    spans: DocumentSpans,
    pdf_path: Path | str,
    asset_root: Path | str,
) -> RenderOutput:
    """Render strips and crop assets for every root span in one document."""
    pdf_path = Path(pdf_path)
    asset_root = Path(asset_root)
    asset_root.mkdir(parents=True, exist_ok=True)

    rendered: list[RenderedSpan] = []
    assets: dict[str, AssetRecord] = {}

    with fitz.open(pdf_path) as document:
        for span in spans.spans:
            rendered.append(_render_span(span, document, asset_root, assets))

    return RenderOutput(
        source_path=str(pdf_path),
        source_sha256=spans.source_sha256,
        doc_type=spans.doc_type,
        rendered_spans=tuple(rendered),
        assets=tuple(assets.values()),
    )


def _render_span(
    span: RootSpan,
    document: fitz.Document,
    asset_root: Path,
    assets: dict[str, AssetRecord],
) -> RenderedSpan:
    strips: list[StripRecord] = []
    figures: list[dict[str, Any]] = []

    for region in span.regions:
        if region.page < 1 or region.page > document.page_count:
            continue
        page = document[region.page - 1]

        strip = _render_strip(page, region, asset_root, assets)
        if strip is not None:
            strips.append(strip)

        for candidate in _find_figures(page, region.bbox):
            asset = _crop_figure(
                page,
                candidate["bbox"],
                asset_root,
                assets,
                kind="table" if candidate["is_table"] else "figure",
            )
            if asset is None:
                continue
            figures.append({
                "id": f"fig{len(figures) + 1}",
                "page": region.page,
                "bbox": [round(value, 3) for value in candidate["bbox"]],
                "kind": asset.kind,
                "sha256": asset.sha256,
                "relative_path": asset.relative_path,
            })

    return RenderedSpan(
        root_number=span.root_number,
        strips=tuple(strips),
        figures=tuple(figures),
        page_start=span.page_start,
        page_end=span.page_end,
    )


def _render_strip(
    page: fitz.Page,
    region: PageRegion,
    asset_root: Path,
    assets: dict[str, AssetRecord],
) -> StripRecord | None:
    """Render one span region, with response furniture painted out.

    The clip is the span rectangle plus a small margin — not the whole page.
    """
    page_rect = page.rect
    x0, y0, x1, y1 = region.bbox

    clip = fitz.Rect(
        max(page_rect.x0, x0 - STRIP_MARGIN_X),
        max(page_rect.y0, y0 - _top_margin(page, y0)),
        min(page_rect.x1, x1 + STRIP_MARGIN_X),
        min(page_rect.y1, y1 + _bottom_margin(page, y1)),
    )

    # A mark-scheme span runs to the bottom of the page whenever its label is
    # the last on that page, so the strip trails a large blank margin that
    # costs upload and tokens while carrying nothing. Trim to what is actually
    # printed.
    content = _content_bounds(page)
    if content is not None:
        trimmed = clip & content
        if not trimmed.is_empty and trimmed.width >= 2 and trimmed.height >= 2:
            clip = trimmed

    # A degenerate span (detector noise) would render a zero-pixel image.
    if clip.width < 2 or clip.height < 2:
        return None

    # Paint over dotted answer rules, barcodes, and page furniture so the model
    # never sees them. Redaction needs a writable page, so this is applied to a
    # scratch copy of the page rather than mutating the open document.
    scratch: fitz.Document | None = None
    render_page = page
    if region.erase_bboxes:
        scratch = fitz.open()
        scratch.insert_pdf(page.parent, from_page=page.number, to_page=page.number)
        render_page = scratch[0]
        # draw_rect works in the page's own unrotated coordinates, while every
        # box reaching here is in the display space page.rect describes. On a
        # rotated mark scheme the two differ by 90 degrees, so a header band
        # painted without this conversion came out as a vertical stripe through
        # the answers. derotation_matrix is the identity on an unrotated page.
        derotate = render_page.derotation_matrix
        for box in region.erase_bboxes:
            rect = fitz.Rect(*box) & page_rect
            if rect.is_empty or rect.width < 1 or rect.height < 1:
                continue
            render_page.draw_rect(rect * derotate, color=None, fill=(1, 1, 1), overlay=True)

    try:
        scale = _capped_scale(clip, MAX_STRIP_EDGE)
        pixmap = render_page.get_pixmap(
            matrix=fitz.Matrix(scale, scale),
            clip=clip,
            alpha=False,
            # Past papers are printed black on white; even their photographs
            # are greyscale. Rendering in colour cost roughly twice the bytes
            # for no information, which across the corpus is tens of GB.
            colorspace=fitz.csGRAY,
        )
        data = pixmap.tobytes("png")
        width, height = pixmap.width, pixmap.height
    finally:
        if scratch is not None:
            scratch.close()

    asset = _store_asset(
        data=data,
        kind="screenshot",
        asset_root=asset_root,
        assets=assets,
        source_page=page.number + 1,
        bbox=(clip.x0, clip.y0, clip.x1, clip.y1),
        width=width,
        height=height,
        dpi=round(scale * 72.0),
    )

    return StripRecord(
        page=page.number + 1,
        bbox=(clip.x0, clip.y0, clip.x1, clip.y1),
        sha256=asset.sha256,
        relative_path=asset.relative_path,
        absolute_path=asset.absolute_path,
    )


def _find_figures(
    page: fitz.Page,
    span_bbox: tuple[float, float, float, float],
) -> list[dict[str, Any]]:
    """Locate figures and tables intersecting a span region.

    Vector drawings, embedded images, and detected tables all describe the same
    diagram surprisingly often, so overlapping candidates are collapsed.
    """
    span_rect = fitz.Rect(*span_bbox)
    candidates: list[dict[str, Any]] = []

    # Tables first: they are the most specific interpretation of a region, and
    # dedup keeps whichever candidate is seen first.
    try:
        for table in page.find_tables().tables:
            rect = fitz.Rect(table.bbox)
            if _usable(rect, span_rect):
                candidates.append({"bbox": tuple(rect), "is_table": True})
    except Exception:
        # Table detection is best-effort; a failure must not lose the figures.
        pass

    for image_ref in page.get_images(full=True):
        for rect in page.get_image_rects(int(image_ref[0])):
            rect = _display(page, rect)
            if _usable(rect, span_rect):
                candidates.append({"bbox": tuple(rect), "is_table": False})

    # Vector paths are clustered before filtering, so a diagram assembled from
    # many small strokes survives as one figure instead of vanishing.
    strokes: list[fitz.Rect] = []
    for drawing in page.get_drawings():
        raw = drawing.get("rect")
        if raw is None:
            continue
        rect = _display(page, raw)
        if rect.is_empty or not rect.intersects(span_rect) or _is_rule(rect):
            continue
        strokes.append(rect)

    for cluster in _cluster(strokes, FIGURE_CLUSTER_GAP):
        if _usable(cluster, span_rect):
            labelled = _expand_with_labels(page, cluster, span_rect)
            candidates.append({"bbox": tuple(labelled), "is_table": False})

    # Reading order, not detection order.
    #
    # The three passes above run tables, then embedded images, then vector
    # clusters, so the ids they were numbered in followed the *detection
    # source* rather than the page. On 0620_s23_qp_41 Q3 that made Fig 3.1
    # `fig3`, Fig 3.2 `fig1` (its answer boxes read as a table) and Fig 3.3
    # `fig2`, and the model — which is shown page strips, not the individual
    # crops — cited all three wrongly while reporting 0.95 confidence.
    #
    # The model can only pair an id with a figure by assuming the ids run down
    # the page. Sorting here makes that assumption true.
    ordered = _dedup(candidates)
    ordered.sort(key=lambda candidate: (round(candidate["bbox"][1], 1), round(candidate["bbox"][0], 1)))
    return ordered


def _expand_with_labels(
    page: fitz.Page,
    cluster: fitz.Rect,
    span_rect: fitz.Rect,
) -> fitz.Rect:
    """Grow a drawing cluster to take in the text labelling it.

    Axis labels, angles, and callouts are text, not vector paths, so a cluster
    built from strokes alone clips them — a crop reading "5.6 m s" with the
    exponent cut off is worse than useless. Growth is capped so a diagram
    sitting inside a paragraph cannot swallow the surrounding prose.
    """
    limit = fitz.Rect(
        max(span_rect.x0, cluster.x0 - cluster.width * MAX_LABEL_GROWTH),
        max(span_rect.y0, cluster.y0 - cluster.height * MAX_LABEL_GROWTH),
        min(span_rect.x1, cluster.x1 + cluster.width * MAX_LABEL_GROWTH),
        min(span_rect.y1, cluster.y1 + cluster.height * MAX_LABEL_GROWTH),
    )
    reach = fitz.Rect(
        cluster.x0 - FIGURE_LABEL_GAP, cluster.y0 - FIGURE_LABEL_GAP,
        cluster.x1 + FIGURE_LABEL_GAP, cluster.y1 + FIGURE_LABEL_GAP,
    )

    result = fitz.Rect(cluster)
    try:
        blocks = page.get_text("blocks")
    except Exception:
        return result

    for block in blocks:
        if len(block) < 5:
            continue
        rect = _display(page, (block[0], block[1], block[2], block[3]))
        text = str(block[4]).strip() if len(block) > 4 else ""
        if not text or rect.is_empty or not rect.intersects(reach):
            continue
        # Only absorb a label that fits the permitted envelope; a long
        # paragraph brushing the diagram is left alone.
        if not limit.contains(rect):
            continue
        result = result | rect

    return result & span_rect if not (result & span_rect).is_empty else result


def _is_rule(rect: fitz.Rect) -> bool:
    """True for a long thin line: an answer rule, underline, or table border."""
    if rect.height <= RULE_MAX_THICKNESS and rect.width >= RULE_MIN_LENGTH:
        return True
    return rect.width <= RULE_MAX_THICKNESS and rect.height >= RULE_MIN_LENGTH


def _cluster(rects: list[fitz.Rect], gap: float) -> list[fitz.Rect]:
    """Merge rectangles that sit within ``gap`` points of one another."""
    remaining = list(rects)
    clusters: list[fitz.Rect] = []
    while remaining:
        current = remaining.pop()
        merged = True
        while merged:
            merged = False
            grown = fitz.Rect(
                current.x0 - gap, current.y0 - gap,
                current.x1 + gap, current.y1 + gap,
            )
            keep: list[fitz.Rect] = []
            for rect in remaining:
                if grown.intersects(rect):
                    current = current | rect
                    merged = True
                    grown = fitz.Rect(
                        current.x0 - gap, current.y0 - gap,
                        current.x1 + gap, current.y1 + gap,
                    )
                else:
                    keep.append(rect)
            remaining = keep
        clusters.append(current)
    return clusters


def _usable(rect: fitz.Rect, span_rect: fitz.Rect) -> bool:
    if not rect.intersects(span_rect):
        return False
    if rect.width < MIN_FIGURE_SIDE or rect.height < MIN_FIGURE_SIDE:
        return False
    return rect.width * rect.height >= MIN_FIGURE_AREA


def _dedup(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop candidates that substantially overlap one already accepted."""
    accepted: list[dict[str, Any]] = []
    for candidate in candidates:
        rect = fitz.Rect(*candidate["bbox"])
        if any(_iou(rect, fitz.Rect(*other["bbox"])) >= FIGURE_DEDUP_IOU for other in accepted):
            continue
        accepted.append(candidate)
    return accepted


def _iou(a: fitz.Rect, b: fitz.Rect) -> float:
    intersection = a & b
    if intersection.is_empty:
        return 0.0
    overlap = intersection.width * intersection.height
    union = (a.width * a.height) + (b.width * b.height) - overlap
    return overlap / union if union > 0 else 0.0


def _crop_figure(
    page: fitz.Page,
    bbox: tuple[float, float, float, float],
    asset_root: Path,
    assets: dict[str, AssetRecord],
    kind: str,
) -> AssetRecord | None:
    rect = fitz.Rect(*bbox) & page.rect
    if rect.is_empty or rect.width < 2 or rect.height < 2:
        return None

    scale = _capped_scale(rect, MAX_FIGURE_EDGE)
    # Greyscale for the same reason as the strips: these papers are printed
    # black on white, and colour doubled the bytes for nothing.
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(scale, scale), clip=rect, alpha=False,
        colorspace=fitz.csGRAY,
    )
    if pixmap.width < 2 or pixmap.height < 2:
        return None

    return _store_asset(
        data=pixmap.tobytes("png"),
        kind=kind,
        asset_root=asset_root,
        assets=assets,
        source_page=page.number + 1,
        bbox=(rect.x0, rect.y0, rect.x1, rect.y1),
        width=pixmap.width,
        height=pixmap.height,
        dpi=round(scale * 72.0),
    )


def _top_margin(page: fitz.Page, top: float) -> float:
    """How far a strip may reach above its region.

    Stage one already pads a region away from its first line, and this margin
    was added on top of that. Where a layout is tight the two together crossed
    into the line above, and the crop opened on a row of clipped descenders —
    "p y [ ]" above every even-numbered History question, thirteen essay
    options to a page. The margin now stops at whatever is printed above.
    """
    matrix = page.rotation_matrix
    nearest = 0.0
    try:
        for block in page.get_text("blocks"):
            if len(block) < 5 or not str(block[4]).strip():
                continue
            bottom = (fitz.Rect(block[0], block[1], block[2], block[3]) * matrix).y1
            if bottom <= top + 0.5:
                nearest = max(nearest, bottom)
    except Exception:
        return STRIP_MARGIN_TOP
    if nearest <= 0.0:
        return STRIP_MARGIN_TOP
    return max(0.0, min(STRIP_MARGIN_TOP, top - nearest))


def _bottom_margin(page: fitz.Page, bottom: float) -> float:
    """How far a strip may reach below its region.

    The mirror of _top_margin. Unclamped it pulled the next question's opening
    line into the crop, which on a History paper — thirteen essay options to a
    page — meant every question ended by showing the start of the next.
    """
    matrix = page.rotation_matrix
    nearest = None
    try:
        for block in page.get_text("blocks"):
            if len(block) < 5 or not str(block[4]).strip():
                continue
            top = (fitz.Rect(block[0], block[1], block[2], block[3]) * matrix).y0
            if top >= bottom - 0.5:
                nearest = top if nearest is None else min(nearest, top)
    except Exception:
        return STRIP_MARGIN_BOTTOM
    if nearest is None:
        return STRIP_MARGIN_BOTTOM
    return max(0.0, min(STRIP_MARGIN_BOTTOM, nearest - bottom))


def _content_bounds(page: fitz.Page) -> fitz.Rect | None:
    """Bounding box of everything actually printed on a page.

    Used to trim blank margins off a strip. Returns ``None`` when the page has
    no detectable content, in which case the caller keeps its original clip.
    """
    # An empty fitz.Rect defaults to (0, 0, 0, 0), and unioning into it would
    # anchor every result to the page origin, so accumulate from None instead.
    bounds: fitz.Rect | None = None

    def absorb(rect: fitz.Rect) -> None:
        nonlocal bounds
        if rect.is_empty:
            return
        bounds = rect if bounds is None else bounds | rect

    try:
        for block in page.get_text("blocks"):
            if len(block) > 4 and str(block[4]).strip():
                absorb(_display(page, (block[0], block[1], block[2], block[3])))
    except Exception:
        return None

    try:
        for drawing in page.get_drawings():
            raw = drawing.get("rect")
            if raw is not None:
                absorb(_display(page, raw))
    except Exception:
        pass

    try:
        for image_ref in page.get_images(full=True):
            for rect in page.get_image_rects(int(image_ref[0])):
                absorb(_display(page, rect))
    except Exception:
        pass

    if bounds is None:
        return None

    # A little slack so glyph edges and rules are not shaved off.
    padded = fitz.Rect(
        bounds.x0 - STRIP_MARGIN_X, bounds.y0 - STRIP_MARGIN_TOP,
        bounds.x1 + STRIP_MARGIN_X, bounds.y1 + STRIP_MARGIN_BOTTOM,
    )
    return padded & page.rect


def _capped_scale(rect: fitz.Rect, max_edge: int) -> float:
    """Render scale for ``rect``, reduced so its long edge fits ``max_edge``."""
    scale = RENDER_DPI / 72.0
    longest = max(rect.width, rect.height) * scale
    if longest > max_edge:
        scale *= max_edge / longest
    return scale


def _store_asset(
    *,
    data: bytes,
    kind: str,
    asset_root: Path,
    assets: dict[str, AssetRecord],
    source_page: int,
    bbox: tuple[float, float, float, float],
    width: int,
    height: int,
    dpi: int = RENDER_DPI,
) -> AssetRecord:
    """Write one PNG under its content address, reusing an identical crop."""
    digest = hashlib.sha256(data).hexdigest()
    existing = assets.get(digest)
    if existing is not None:
        return existing

    relative_path = f"assets/sha256/{digest[:2]}/{digest}.png"
    destination = asset_root / relative_path
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Write then rename so a crash never leaves a truncated asset behind.
        temporary = destination.with_suffix(".png.partial")
        temporary.write_bytes(data)
        temporary.replace(destination)

    record = AssetRecord(
        sha256=digest,
        kind=kind,
        relative_path=relative_path,
        absolute_path=str(destination.resolve()),
        width=width,
        height=height,
        byte_size=len(data),
        source_page=source_page,
        bbox=bbox,
        source_dpi=dpi,
    )
    assets[digest] = record
    return record
