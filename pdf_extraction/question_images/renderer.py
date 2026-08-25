from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
import math
from pathlib import Path
from typing import Any

import cv2
import fitz
import numpy as np
from PIL import Image, ImageDraw

from .models import SourceRegion


TARGET_DPI = 200
MINIMUM_DPI = 120
MAXIMUM_HEIGHT = 30_000
SEPARATOR_PIXELS = 24
PREVIEW_DPI = 72
PREVIEW_MAXIMUM = (1200, 1800)


@dataclass(frozen=True)
class RenderResult:
    accepted: bool
    dpi: int
    width: int
    height: int
    mode: str
    image_sha256: str | None
    image_path: str | None
    byte_size: int
    diagnostics: tuple[dict[str, Any], ...] = ()
    analysis: dict[str, Any] | None = None


def choose_render_dpi(regions: list[SourceRegion]) -> int | None:
    if not regions:
        return None
    total_points = sum(max(0.0, region.bbox[3] - region.bbox[1]) for region in regions)
    separators = max(0, len(regions) - 1) * SEPARATOR_PIXELS
    available = MAXIMUM_HEIGHT - separators
    predicted = math.ceil(total_points * TARGET_DPI / 72) + separators
    if predicted <= MAXIMUM_HEIGHT:
        return TARGET_DPI
    reduced = min(TARGET_DPI, math.floor(available * 72 / max(total_points, 1)))
    if reduced < MINIMUM_DPI:
        return None
    return reduced


def render_accepted_asset(
    pdf_path: Path,
    regions: list[SourceRegion],
    output_root: Path,
) -> RenderResult:
    dpi = choose_render_dpi(regions)
    if dpi is None:
        return RenderResult(
            accepted=False,
            dpi=MINIMUM_DPI,
            width=0,
            height=0,
            mode="",
            image_sha256=None,
            image_path=None,
            byte_size=0,
            diagnostics=({"reason": "image_exceeds_height_limit", "maximumHeight": MAXIMUM_HEIGHT},),
        )

    with fitz.open(pdf_path) as document:
        strips = [_render_region(document, region, dpi) for region in regions]
    stitched = stitch_strips(strips)
    if stitched.height > MAXIMUM_HEIGHT:
        return RenderResult(
            accepted=False,
            dpi=dpi,
            width=stitched.width,
            height=stitched.height,
            mode=stitched.mode,
            image_sha256=None,
            image_path=None,
            byte_size=0,
            diagnostics=({"reason": "image_exceeds_height_limit", "height": stitched.height},),
        )

    analysis = analyze_visual_region(stitched)
    if analysis["inkFraction"] <= 0.00005:
        return RenderResult(
            accepted=False,
            dpi=dpi,
            width=stitched.width,
            height=stitched.height,
            mode=stitched.mode,
            image_sha256=None,
            image_path=None,
            byte_size=0,
            diagnostics=({"reason": "blank_render"},),
            analysis=analysis,
        )

    material_color = bool(analysis["materialColor"])
    output = stitched.convert("RGB" if material_color else "L")
    mode = "color" if material_color else "grayscale"
    payload = _png_bytes(output)
    digest = sha256(payload).hexdigest()
    asset_path = output_root / "assets" / "sha256" / digest[:2] / f"{digest}.png"
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    if not asset_path.exists():
        temporary = asset_path.with_suffix(".png.partial")
        temporary.write_bytes(payload)
        temporary.replace(asset_path)
    return RenderResult(
        accepted=True,
        dpi=dpi,
        width=output.width,
        height=output.height,
        mode=mode,
        image_sha256=digest,
        image_path=str(asset_path.relative_to(output_root)),
        byte_size=len(payload),
        analysis=analysis,
    )


def render_review_preview(
    pdf_path: Path,
    regions: list[SourceRegion],
    output_root: Path,
    document_id: str,
    record_id: str,
) -> str | None:
    if not regions:
        return None
    with fitz.open(pdf_path) as document:
        strips = [_render_region(document, region, PREVIEW_DPI) for region in regions]
    preview = stitch_strips(strips)
    preview.thumbnail(PREVIEW_MAXIMUM, Image.Resampling.LANCZOS)
    preview = preview.convert("RGB")
    payload = _png_bytes(preview)
    preview_path = output_root / "previews" / document_id / f"{record_id}.png"
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = preview_path.with_suffix(".png.partial")
    temporary.write_bytes(payload)
    temporary.replace(preview_path)
    return str(preview_path.relative_to(output_root))


def stitch_strips(strips: list[Image.Image], separator: int = SEPARATOR_PIXELS) -> Image.Image:
    if not strips:
        raise ValueError("At least one strip is required")
    width = max(image.width for image in strips)
    height = sum(image.height for image in strips) + max(0, len(strips) - 1) * separator
    canvas = Image.new("RGB", (width, height), "white")
    y = 0
    for index, strip in enumerate(strips):
        x = (width - strip.width) // 2
        canvas.paste(strip.convert("RGB"), (x, y))
        y += strip.height
        if index + 1 < len(strips):
            y += separator
    return canvas


def analyze_visual_region(image: Image.Image) -> dict[str, Any]:
    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ink = gray < 245
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    saturated = hsv[:, :, 1] > 24
    color_fraction = float(np.count_nonzero(saturated)) / max(1, saturated.size)
    ink_fraction = float(np.count_nonzero(ink)) / max(1, ink.size)
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, image.width // 30), 1))
    horizontal = cv2.morphologyEx((ink.astype(np.uint8) * 255), cv2.MORPH_OPEN, horizontal_kernel)
    structural_fraction = float(np.count_nonzero(horizontal)) / max(1, horizontal.size)
    return {
        "inkFraction": round(ink_fraction, 7),
        "colorFraction": round(color_fraction, 7),
        "materialColor": color_fraction >= 0.003,
        "horizontalStructureFraction": round(structural_fraction, 7),
    }


def _render_region(document: fitz.Document, region: SourceRegion, dpi: int) -> Image.Image:
    page = document[region.page - 1]
    clip = fitz.Rect(*region.bbox) & page.rect
    if clip.is_empty or clip.width <= 0 or clip.height <= 0:
        raise ValueError(f"Empty source region on page {region.page}: {region.bbox}")
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(dpi / 72, dpi / 72),
        clip=clip,
        alpha=False,
        colorspace=fitz.csRGB,
    )
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    if region.erase_bboxes:
        draw = ImageDraw.Draw(image)
        scale = dpi / 72
        for bbox in region.erase_bboxes:
            erase = fitz.Rect(*bbox) & clip
            if erase.is_empty:
                continue
            coordinates = (
                math.floor((erase.x0 - clip.x0) * scale),
                math.floor((erase.y0 - clip.y0) * scale),
                math.ceil((erase.x1 - clip.x0) * scale),
                math.ceil((erase.y1 - clip.y0) * scale),
            )
            draw.rectangle(coordinates, fill="white")
    return image


def _png_bytes(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG", compress_level=9, optimize=False)
    return output.getvalue()
