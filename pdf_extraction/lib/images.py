"""
Coordinate-based image↔question linking.

Replaces the old naive sequential distribution with spatial matching:
each extracted image (with bbox) is linked to the question whose text bbox
is nearest on the same page. Falls back to nearest-on-page if no exact match.
"""
import re
from typing import List, Dict, Tuple


def _parse_question_number(label: str) -> Tuple[int, str, str]:
    """'3(b)(ii)' → (3, 'b', 'ii')."""
    s = str(label).lower().strip()
    m = re.match(r"^(\d+)\s*([a-z])?(?:\(([a-z]+)\))?", s)
    if not m:
        return (0, "", "")
    return (int(m.group(1)), m.group(2) or "", m.group(3) or "")


def _vertical_distance(img: Dict, block: Dict) -> float:
    """Vertical gap between image bottom and block top (negative = overlap)."""
    # image sits below the question text → positive distance = image follows text
    return img["y0"] - block["y1"]


def link_images_to_questions(
    question_rows: List[Dict],
    text_blocks: List[Dict],
    images: List[Dict],
) -> Dict[int, List[Dict]]:
    """
    Given extracted questions (with number/label), the PDF's text blocks (with bbox),
    and extracted images (with bbox), return a mapping:
        question_db_id → [ {filename, page, bbox...}, ... ]

    Algorithm:
      1. For each text block, detect which question number it belongs to.
      2. Group images by page.
      3. For each image, find the nearest preceding question-text block on
         the same page (the question the image belongs to).
      4. Map back to the question db id.
    """
    if not question_rows or not images:
        return {}

    # Step 1: classify each text block by question number
    # A block "belongs to" question N if it starts with "N" or "Na" etc.
    block_to_qnum: List[Tuple[Dict, Tuple]] = []
    qnum_pattern = re.compile(r"^\s*(\d+)\s*([a-z])?(?:\s*[\(\[](?:[a-z]+|\d+)[\)\]])?", re.IGNORECASE)

    for blk in text_blocks:
        m = qnum_pattern.match(blk["text"][:20])
        if m:
            qn = (int(m.group(1)), m.group(2) or "", "")
            block_to_qnum.append((blk, qn))

    # Step 2: for each image, find nearest preceding text-block's question
    # images by page
    images_by_page: Dict[int, List[Dict]] = {}
    for img in images:
        images_by_page.setdefault(img["page"], []).append(img)

    # question-number → list of images
    qnum_to_images: Dict[Tuple, List[Dict]] = {}
    for page, page_images in images_by_page.items():
        # blocks on this page, sorted top-to-bottom
        page_blocks = sorted(
            [b for b in block_to_qnum if b[0]["page"] == page],
            key=lambda x: x[0]["y0"],
        )
        page_images_sorted = sorted(page_images, key=lambda i: i["y0"])

        # propagate question number down the page: each block stamps its qn
        # until a new block overrides it
        for img in page_images_sorted:
            # find the last block whose y0 < img y0 (text above the image)
            owner_qn = None
            best_gap = float("inf")
            for blk, qn in reversed(page_blocks):
                if blk["y1"] <= img["y0"] + 5:  # block is above image
                    gap = img["y0"] - blk["y1"]
                    if gap < best_gap:
                        best_gap = gap
                        owner_qn = qn
                    break
            if owner_qn is None:
                # image is above all question text on this page → take first block below
                for blk, qn in page_blocks:
                    if blk["y0"] > img["y0"]:
                        owner_qn = qn
                        break
            if owner_qn is None:
                continue
            qnum_to_images.setdefault(owner_qn, []).append(img)

    # Step 3: map question-number → question db id
    result: Dict[int, List[Dict]] = {}
    for q in question_rows:
        qn = _parse_question_number(q["number"])
        imgs = qnum_to_images.get(qn)
        if imgs:
            result[q["db_id"]] = imgs
    return result
