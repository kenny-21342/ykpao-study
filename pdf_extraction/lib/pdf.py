"""
PDF text and image extraction (PyMuPDF/fitz).

Key improvement: preserves spatial coordinates (bbox) for both text blocks
and images, enabling coordinate-based question↔image linking.
"""
import re
import unicodedata
from pathlib import Path
from typing import List, Dict, Optional

import fitz

from .config import MIN_IMAGE_BYTES


def sanitize_text(text: str) -> str:
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


def extract_text(pdf_path: Path, max_chars: int = 40000) -> str:
    """Plain text extraction (legacy single-pass)."""
    try:
        doc = fitz.open(pdf_path)
        parts, total = [], 0
        for page in doc:
            t = sanitize_text(page.get_text())
            if total + len(t) > max_chars:
                parts.append(t[: max_chars - total])
                break
            parts.append(t)
            total += len(t)
        doc.close()
        return "\n".join(parts)
    except Exception as e:
        print(f"[PDF ERROR] {e}")
        return ""


def extract_pages(pdf_path: Path) -> List[str]:
    """Per-page text (for chunked extraction)."""
    try:
        doc = fitz.open(pdf_path)
        pages = [sanitize_text(p.get_text()) for p in doc]
        doc.close()
        return pages
    except Exception as e:
        print(f"[PDF ERROR] {e}")
        return []


def group_pages(pages: List[str], max_chars: int = 5000) -> List[str]:
    """Bundle pages into chunks under max_chars."""
    chunks, cur = [], ""
    for page in pages:
        if cur and len(cur) + len(page) > max_chars:
            chunks.append(cur.strip())
            cur = page
        else:
            cur += ("\n" + page) if cur else page
    if cur:
        chunks.append(cur.strip())
    return chunks


def extract_images_with_coords(
    pdf_path: Path, output_dir: Path, paper_prefix: str, doc_type: str
) -> List[Dict]:
    """
    Extract every image with its page number + bbox.
    Returns list of:
      {filename, abs_path, page, x0, y0, x1, y1, width, height, bytes}
    Images < MIN_IMAGE_BYTES are skipped (logos/icons).
    For mark schemes, skip first 3 pages (generic guidance, no figures).
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    start_page = 3 if doc_type == "ms" else 0
    results: List[Dict] = []

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        print(f"[IMAGE ERROR] cannot open {pdf_path.name}: {e}")
        return results

    for page_num in range(start_page, len(doc)):
        page = doc[page_num]
        for img_index, img_info in enumerate(page.get_images(full=True)):
            xref = img_info[0]
            try:
                base = doc.extract_image(xref)
                img_bytes = base["image"]
                if len(img_bytes) < MIN_IMAGE_BYTES:
                    continue
                ext = base["ext"]
                bbox = page.get_image_bbox(img_info)

                fname = f"{paper_prefix}_p{page_num + 1}_i{img_index}.{ext}"
                out_path = output_dir / fname
                with open(out_path, "wb") as f:
                    f.write(img_bytes)

                results.append({
                    "filename": fname,
                    "page": page_num + 1,
                    "x0": bbox.x0, "y0": bbox.y0,
                    "x1": bbox.x1, "y1": bbox.y1,
                    "width": bbox.width, "height": bbox.height,
                    "bytes": len(img_bytes),
                })
            except Exception:
                continue
    doc.close()
    return results


def extract_question_blocks(pdf_path: Path) -> List[Dict]:
    """
    Extract text blocks with their bboxes, for coordinate-based image linking.
    Returns: [{text, page, x0, y0, x1, y1}, ...] sorted by (page, y0).
    """
    try:
        doc = fitz.open(pdf_path)
    except Exception:
        return []
    blocks: List[Dict] = []
    for page_num, page in enumerate(doc):
        for blk in page.get_text("blocks"):
            x0, y0, x1, y1, text = blk[:5]
            t = sanitize_text(text)
            if t and len(t) > 3:
                blocks.append({
                    "text": t,
                    "page": page_num + 1,
                    "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                })
    doc.close()
    blocks.sort(key=lambda b: (b["page"], b["y0"]))
    return blocks
