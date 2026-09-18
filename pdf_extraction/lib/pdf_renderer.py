"""
PDF renderer: converts each page to a PNG image + extracts spatial metadata.

For each page we produce:
  - page_NN.png       (200 DPI render — high enough for Gemini to read)
  - text_blocks       (bbox + text for each block — used for image linking)
  - image_regions     (bbox for each embedded image — used for image extraction)

The PNGs are sent to Gemini for vision-based extraction.
The text_blocks + image_regions are used by the normaliser to link extracted
images to the correct questions (coordinate-based, no guessing).
"""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF

DPI = 200  # render resolution — 200 is the sweet spot for Gemini OCR accuracy


def render_pages(
    pdf_path: Path,
    output_dir: Path,
    paper_prefix: str,
    max_pages: int = 0,
) -> list[dict[str, Any]]:
    """
    Render every page of the PDF as a PNG + collect spatial metadata.

    Returns a list of page dicts:
      {page: int, image_path: Path, text_blocks: [...], image_regions: [...]}

    Args:
        pdf_path: path to the source PDF.
        output_dir: where to write the PNG files.
        paper_prefix: e.g. "0610_s24_qp_12" — used in filenames.
        max_pages: 0 = all pages, else limit.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    pages_data: list[dict[str, Any]] = []

    page_count = doc.page_count if max_pages == 0 else min(doc.page_count, max_pages)

    for i in range(page_count):
        page = doc[i]

        # --- Render PNG ---
        zoom = DPI / 72  # PyMuPDF uses 72 DPI base
        matrix = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        img_filename = f"{paper_prefix}_p{i + 1:02d}.png"
        img_path = output_dir / img_filename
        pix.save(str(img_path))

        # --- Text blocks with bboxes ---
        # get_text("blocks") returns (x0, y0, x1, y1, text, block_no, block_type)
        raw_blocks = page.get_text("blocks")
        text_blocks = []
        for block in raw_blocks:
            x0, y0, x1, y1, text, _block_no, _block_type = block
            text_clean = _sanitize_text(text)
            if text_clean and len(text_clean.strip()) > 1:
                text_blocks.append({
                    "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                    "text": text_clean,
                    "page": i + 1,
                })

        # --- Image regions with bboxes ---
        image_regions = []
        for img_info in page.get_images(full=True):
            xref = img_info[0]
            try:
                rects = page.get_image_rects(xref)
                for rect in rects:
                    # Only include images that are reasonably sized (not tiny icons)
                    width = rect.width
                    height = rect.height
                    if width > 40 and height > 40:  # skip tiny logos/icons
                        image_regions.append({
                            "x0": rect.x0, "y0": rect.y0,
                            "x1": rect.x1, "y1": rect.y1,
                            "xref": xref,
                            "page": i + 1,
                            "width": width,
                            "height": height,
                        })
            except Exception:
                continue

        pages_data.append({
            "page": i + 1,
            "image_path": img_path,
            "text_blocks": text_blocks,
            "image_regions": image_regions,
        })

    doc.close()
    return pages_data


def extract_image_bytes(pdf_path: Path, xref: int) -> bytes | None:
    """Extract the raw image bytes for a given xref from the PDF."""
    try:
        doc = fitz.open(pdf_path)
        base_image = doc.extract_image(xref)
        doc.close()
        return base_image["image"]
    except Exception:
        return None


def _sanitize_text(text: str) -> str:
    """Strip control chars that break JSON, normalize unicode."""
    text = "".join(
        ch for ch in text
        if ch in "\n\t" or not unicodedata.category(ch).startswith("C")
    )
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("\x00", "").replace("\ufffd", "")
    text = re.sub(r" +", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
