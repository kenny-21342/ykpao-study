"""Which sub-parts a question has.

Two sources, in order of trust:

1. ``bank_questions.parts`` -- labels and marks read off the paper layout during
   extraction (``[{"label": "a(i)", "marks": 3}]``). 22,153 published questions
   have it, and it is the authority: it carries marks, which the text does not.
2. The transcribed text itself, for the few that have no stored parts: the bold
   markers the transcriber writes (``**(a)**``, ``**(b)(ii)**``).

A gold check of (2) against (1) over the 22,223 questions that have both
agrees on the label list for 77%. The misses are almost all questions whose
roman sub-parts appear on the paper but not as markers in the text, so (2) is
only ever used where (1) is absent, and only when it finds two or more parts.
A question with fewer than two parts is a single-part question; its question
level tags already describe it and it gets no part rows.
"""

from __future__ import annotations

import json
import re
from typing import Any

ROMAN = {"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"}
_MARKER = re.compile(r"(?m)^\*\*((?:\([a-z]+\))+)\*\*")
_MARKS = re.compile(r"\[(\d{1,2})\]\s*$")


def segment(body_md: str) -> list[dict[str, Any]]:
    """Parts found in the text: ``[{"label", "marks", "text"}]``.

    ``marks`` is only known when the part ends in ``[n]``; for most CAIE
    questions it is None because the mark sits in the page margin.
    """
    matches = [
        (m.start(), m.end(), re.findall(r"\(([a-z]+)\)", m.group(1)))
        for m in _MARKER.finditer(body_md or "")
    ]
    parts: list[dict[str, Any]] = []
    current: str | None = None
    for index, (_start, end, tokens) in enumerate(matches):
        if len(tokens) == 2 and tokens[1] in ROMAN:
            current = tokens[0]
            label = f"{tokens[0]}({tokens[1]})"
        elif len(tokens) == 1:
            token = tokens[0]
            # (i) after (h) is a letter, not a numeral; same for (v) after (u)
            # and (x) after (w).
            is_roman = (
                current is not None
                and token in ROMAN
                and not (token == "i" and current == "h")
                and not (token == "v" and current == "u")
                and not (token == "x" and current == "w")
            )
            if is_roman:
                label = f"{current}({token})"
            else:
                current = token
                label = token
        else:
            continue
        stop = matches[index + 1][0] if index + 1 < len(matches) else len(body_md)
        text = body_md[end:stop].strip()
        mark = _MARKS.search(text)
        parts.append({"label": label, "marks": int(mark.group(1)) if mark else None, "text": text})

    # A letter whose own sub-parts follow ("a" then "a(i)", "a(ii)") is a
    # heading for them, not a part.
    labels = [part["label"] for part in parts]
    return [
        part for part in parts
        if "(" in part["label"] or not any(other.startswith(part["label"] + "(") for other in labels)
    ]


def parts_for_question(parts_json: str | None, body_md: str) -> list[dict[str, Any]]:
    """Stored parts when there are two or more, else the text's, else none."""
    try:
        stored = json.loads(parts_json or "[]")
    except ValueError:
        stored = []
    clean = [
        {"label": str(p["label"]), "marks": p.get("marks")}
        for p in stored
        if isinstance(p, dict) and str(p.get("label", "")).strip()
    ]
    if len(clean) >= 2:
        return clean
    found = segment(body_md)
    if len(found) >= 2:
        return [{"label": p["label"], "marks": p["marks"]} for p in found]
    return []
