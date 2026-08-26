"""One definition of "erasing this would destroy content".

The renderer paints white over answer rules, barcodes and page furniture before
a crop is rendered. Nothing stopped a box covering the question itself, and a
question shipped reading "the line y = ax +" with its constant painted out.

Two places need to agree about what counts as content: the guard that refuses
to paint such a box, and the QA check that reports when one slipped through. If
they disagree the check either misses real damage or floods on furniture, so
both import from here.

The geometry convention throughout is display space -- word boxes multiplied by
`page.rotation_matrix`, erase boxes as stored. That is the convention
`qa.py::_crop_words` already used and the one `renderer.py::_render_strip`
receives its boxes in.
"""

from __future__ import annotations

import re

# How much of a word an erase box must cover before the word is gone. Below
# this a box is only clipping ascenders or descenders.
COVERAGE_THRESHOLD = 0.30

# A word made only of answer-rule characters. Removing these is the whole point
# of an erase box.
_RULE_ONLY = re.compile(r"^[.…_\-\s]+$")

# Barcodes, in the three shapes they extract as: a run of non-ASCII bytes, the
# candidate-number digits themselves, and the asterisks that delimit them.
# Measured over a sample, "*" was the single most-erased token on the corpus —
# all of it barcode, none of it content.
#
# Twelve digits, not eight: candidate numbers run to thirteen
# (0000800000009), while an eight-digit run is far more likely to be a binary
# value a Computer Science question is *about*. Erasing 01111101 destroys the
# question; erasing 0000800000009 is the entire point of the box.
_BARCODE = re.compile(r"^(?:[^\x00-\x7F]{6,}|\d{12,}|\*+)$")

# Characters that make up an answer rule.
_RULE_CHARS = set(".…_")

# Above this share of rule characters a word IS a rule, whatever is stuck to it.
#
# PyMuPDF returns "..........[1]" as one word, so an erase box that covers only
# the dots still covers most of the word's area and the whole token scored as a
# casualty. The rule is erased on purpose and the "[1]" beside it is left
# standing by the glyph-measured box, so counting these buried real damage
# under hundreds of false positives.
_RULE_SHARE = 0.5

# Page furniture, named literally.
#
# This list used to end with `.{1,2}` -- a catch-all matching EVERY one- and
# two-character token -- and to whitelist any bare `\d{1,3}`. Between them a
# lost "9", "of" or "[4]" was indistinguishable from a page number, which is
# exactly why the erased constant in `y = ax + 9` was never reported. Both are
# gone. A four-digit year stays, because it only ever appears here in the
# copyright line and never as a lone erased constant.
_FURNITURE = re.compile(
    r"^(?:©|UCLES|\d{4}"
    r"|\d{4}/\d\d/[A-Z]/[A-Z]/\d\d"
    r"|\[?Turn|over\]?"
    r"|DO|NOT|WRITE|IN|THIS|MARGIN|MARG"
    r"|Permission|reproduce|third-party|owned"
    r"|protected|copyright|included|Every|reasonable|effort"
    r"|Cambridge|International|Assessment|Education|www\.[\w.]+"
    r")$"
)

# A trailing run of rule characters is part of the rule, not the word.
_TRAILING_RULE = re.compile(r"[.…_]{2,}\s*$")


def normalise_token(word: str) -> str:
    """The word with any answer rule trailing off its end removed."""
    return _TRAILING_RULE.sub("", word) or word


def is_content_token(word: str) -> bool:
    """Whether erasing this word destroys something a student needs.

    Deliberately generous about what counts as content: a single digit is
    content, because a lost constant makes a question unanswerable while
    reading as complete.
    """
    if _RULE_ONLY.match(word):
        return False
    if word and sum(char in _RULE_CHARS for char in word) / len(word) >= _RULE_SHARE:
        return False
    token = normalise_token(word)
    return not _FURNITURE.match(token) and not _BARCODE.match(token)


def coverage(word_box, erase_boxes) -> float:
    """The largest fraction of `word_box` any single erase box covers."""
    area = word_box.get_area()
    if not area:
        return 0.0
    worst = 0.0
    for erase in erase_boxes:
        overlap = word_box & erase
        if not overlap.is_empty:
            worst = max(worst, overlap.get_area() / area)
    return worst


def content_words(page, clip=None):
    """Words on the page that carry content, in display space.

    `clip` restricts to a strip's bounding box; without it the whole page is
    considered, which is what the render-time guard wants.
    """
    import fitz

    matrix = page.rotation_matrix
    rect = fitz.Rect(*clip) if clip is not None else None
    for wx0, wy0, wx1, wy1, word, *_ in page.get_text("words"):
        box = fitz.Rect(wx0, wy0, wx1, wy1) * matrix
        if rect is not None and (box & rect).is_empty:
            continue
        if is_content_token(word):
            yield box, word


# A box is refused when this share of the words it covers are content.
#
# A single word blocking a whole box is too strict: the copyright notice is a
# fixed sentence of ordinary English -- "... Education is part of ... has been
# ... To avoid ..." -- so a word-by-word test refuses the band that erases it
# and the notice stays printed in the crop. Judging the box by what it mostly
# covers separates the two cases cleanly: a box over a lone constant is 100%
# content, a misclassified stem line is nearly all content, and a copyright
# band is mostly boilerplate.
_CONTENT_SHARE = 0.5

# The rest of the Cambridge copyright notice, which is ordinary English:
# "Permission to reproduce items where third-party owned material protected by
# copyright is included has been sought and cleared where possible."
#
# Deliberately used ONLY when judging whether a box is mostly boilerplate, and
# never by is_content_token. The two answer different questions: the guard asks
# "is this box erasing a notice or a question?", the check asks "did we lose
# something a student needed?". Treating "is" or "the" as furniture in the
# second would start hiding real losses, which is the bug this all began with.
_NOTICE_WORDS = frozenset(
    """
    to is by the of and has been where items material sought cleared possible
    made publisher trace holders any at in on for with that this it its as an
    avoid issue disclosure answer-related information candidate live
    examinations copyright part cambridge local school tests exams series
    """.split()
)


def filter_erase_boxes(page, boxes, *, threshold: float = COVERAGE_THRESHOLD):
    """Split erase boxes into those safe to paint and those that would destroy content.

    A box is dropped whole rather than clipped around the word it hits. The
    boxes that matter here come from two places: glyph-measured answer rules,
    which stop at the first character that is not a dot and so never cover a
    word, and whole text lines classified as furniture. Only the second kind
    ever trips this, and for those dropping is the right answer -- the line was
    misread as furniture, so none of it should have been painted.

    Leaving an answer rule visible is a blemish. Painting out the constant a
    question turns on makes it unanswerable while it still reads as complete.
    """
    import fitz

    if not boxes:
        return [], []

    matrix = page.rotation_matrix
    every_word = [
        (fitz.Rect(wx0, wy0, wx1, wy1) * matrix, word)
        for wx0, wy0, wx1, wy1, word, *_ in page.get_text("words")
    ]

    kept, dropped = [], []
    for box in boxes:
        rect = fitz.Rect(*box)
        covered = [
            word for word_box, word in every_word
            if coverage(word_box, [rect]) >= threshold
        ]
        content = [
            word for word in covered
            if is_content_token(word) and word.lower().strip('.,()') not in _NOTICE_WORDS
        ]
        if covered and len(content) / len(covered) > _CONTENT_SHARE:
            dropped.append((box, content[0]))
        else:
            kept.append(box)
    return kept, dropped
