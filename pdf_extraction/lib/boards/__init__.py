"""
Board plugin interface and implementations (CAIE + IB).

Each plugin knows how to:
  1. parse_filename(path) → metadata (subject, year, session, paper, doc_type)
  2. match_ms_to_qp(qp_questions, ms_questions) → paired list
  3. subject_name(code) → human-readable name
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Protocol


class BoardPlugin(Protocol):
    code: str

    def parse_filename(self, path: Path) -> dict[str, Any] | None: ...
    def subject_name(self, code: str) -> str: ...
    def match_ms_to_qp(
        self,
        qp_questions: list[dict],
        ms_questions: list[dict],
    ) -> list[dict[str, Any]]: ...


# ---------------------------------------------------------------------------
# CAIE
# ---------------------------------------------------------------------------

CAIE_SUBJECTS = {
    "0610": "Biology", "0620": "Chemistry", "0625": "Physics",
    "0606": "Additional Mathematics",
    # Added 24 Aug 2026 with the papers themselves. Without a name here the
    # parser falls back to "Subject 0475", which is what the site would have
    # shown a student.
    "0400": "Art & Design",
    "0410": "Music",
    "0411": "Drama",
    "0413": "Physical Education",
    "0450": "Business Studies",
    "0475": "Literature in English", "0580": "Mathematics",
    "0607": "Mathematics International", "0478": "Computer Science",
    "0455": "Economics", "0500": "English First Language",
    "0460": "Geography", "0470": "History", "0509": "Chinese First Language",
    "9709": "Mathematics A-Level", "9231": "Further Mathematics A-Level",
    "9702": "Physics A-Level", "9708": "Economics A-Level",
    "9608": "Computer Science A-Level", "9618": "Computer Science A-Level",
}


class CAIEPlugin:
    code = "CAIE"

    def parse_filename(self, path: Path) -> dict[str, Any] | None:
        """
        0610_s24_qp_12.pdf → {code, year, session, paper, variant, doc_type}
        """
        name = path.name
        parts = name.replace(".pdf", "").split("_")
        if len(parts) < 4:
            return None
        code, sess_str, doc_type, var_str = parts[0], parts[1], parts[2], parts[3]
        if doc_type not in ("qp", "ms", "in"):
            return None
        try:
            year = 2000 + int(sess_str[1:])
            session = {"s": "May/June", "w": "Oct/Nov", "m": "March"}.get(sess_str[0], sess_str[0])
            paper = int(var_str[0])
            variant = int(var_str[1]) if len(var_str) > 1 else 0
        except (ValueError, IndexError):
            return None
        return {
            "board": "CAIE",
            "code": code,
            "year": year,
            "session": sess_str[0],  # keep single-letter for DB
            "paper": paper,
            "variant": variant,
            "doc_type": doc_type,
            "filename": name,
            "filepath": str(path),
        }

    def subject_name(self, code: str) -> str:
        return CAIE_SUBJECTS.get(code, f"Subject {code}")

    def match_ms_to_qp(
        self,
        qp_questions: list[dict],
        ms_questions: list[dict],
    ) -> list[dict[str, Any]]:
        """
        CAIE MS entries have labels matching QP labels: "1(a)(ii)".
        Direct label match.
        """
        ms_map: dict[str, dict] = {}
        for ms in ms_questions:
            label = ms.get("label", "").lower().strip()
            if label:
                ms_map[label] = ms

        paired = []
        for qp in qp_questions:
            label = qp.get("label", "").lower().strip()
            ms = ms_map.get(label)
            paired.append({"qp": qp, "ms": ms})
        return paired


# ---------------------------------------------------------------------------
# IB
# ---------------------------------------------------------------------------

class IBPlugin:
    code = "IB"

    def parse_filename(self, path: Path) -> dict[str, Any] | None:
        """
        IB filename + path → subject, paper, timezone, doc_type.

        Handles two naming conventions:
          "Biology_paper_1__TZ1_HL.pdf"        (double underscore separator)
          "Biology_paper_1A_TZ1_HL.pdf"         (single underscore throughout)
          "Biology_paper_2__SL_markscheme.pdf"  (mark scheme)
        """
        name = path.name.replace(".pdf", "")

        # Normalise: replace "__" with "_" so both patterns parse the same way.
        normalised = name.replace("__", "_")
        parts = normalised.split("_")

        if len(parts) < 3:
            return None

        # Subject = everything before "paper"
        # Find where "paper" appears
        paper_idx = None
        for i, part in enumerate(parts):
            if part.lower() == "paper":
                paper_idx = i
                break
        if paper_idx is None or paper_idx == 0:
            return None

        subject = " ".join(parts[:paper_idx])
        # Paper number — could be "1", "1A", "2B", etc.
        paper_str = parts[paper_idx + 1] if paper_idx + 1 < len(parts) else "1"
        paper_match = re.search(r"(\d+)", paper_str)
        if not paper_match:
            return None
        paper_num = int(paper_match.group(1))

        # Remaining parts after paper number — look for TZ, level, doc_type
        remaining = parts[paper_idx + 2:]
        remaining_lower = "_".join(remaining).lower()

        is_ms = "markscheme" in remaining_lower or "marking" in remaining_lower
        is_insert = any(k in remaining_lower for k in [
            "resource", "text booklet", "data", "reading", "insert", "question booklet"
        ])
        level = "HL" if "hl" in remaining_lower else "SL" if "sl" in remaining_lower else ""
        tz_match = re.search(r"tz(\d)", remaining_lower)
        timezone = f"TZ{tz_match.group(1)}" if tz_match else ""

        doc_type = "ms" if is_ms else ("in" if is_insert else "qp")

        # Year + session from path
        full_path = str(path)
        year_match = re.search(r"(\d{4})", full_path)
        year = int(year_match.group(1)) if year_match else 0
        session = "May" if "May" in full_path else ("November" if "November" in full_path else "")

        return {
            "board": "IB",
            "code": subject,
            "year": year,
            "session": session,
            "paper": paper_num,
            "variant": 0,
            "doc_type": doc_type,
            "level": level,
            "timezone": timezone,
            "filename": path.name,
            "filepath": str(path),
        }

    def subject_name(self, code: str) -> str:
        return code  # IB code is already the subject name

    def match_ms_to_qp(
        self,
        qp_questions: list[dict],
        ms_questions: list[dict],
    ) -> list[dict[str, Any]]:
        """
        IB mark schemes often don't have part labels. Match by order + text
        similarity as fallback.
        """
        # Try label match first (same as CAIE).
        ms_map: dict[str, dict] = {}
        for ms in ms_questions:
            label = ms.get("label", "").lower().strip()
            if label:
                ms_map[label] = ms

        paired = []
        ms_remaining = list(ms_questions)
        for qp in qp_questions:
            label = qp.get("label", "").lower().strip()
            if label and label in ms_map:
                paired.append({"qp": qp, "ms": ms_map[label]})
                if ms_map[label] in ms_remaining:
                    ms_remaining.remove(ms_map[label])
                continue
            # Fallback: positional match (IB MS entries follow same order as QP)
            if ms_remaining:
                paired.append({"qp": qp, "ms": ms_remaining.pop(0)})
            else:
                paired.append({"qp": qp, "ms": None})
        return paired


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

PLUGINS: dict[str, BoardPlugin] = {
    "CAIE": CAIEPlugin(),
    "IB": IBPlugin(),
}


def detect_board(path: Path) -> str | None:
    """Auto-detect board from filename pattern."""
    name = path.name.lower()
    # CAIE: "0610_s24_qp_12.pdf" — 4-digit code, _s/w/m, _qp/ms/in_, variant
    if re.match(r"^\d{4}_[swm]\d{2}_(qp|ms|in)_\d+\.pdf$", name):
        return "CAIE"
    # IB: "Biology_paper_1__TZ1_HL.pdf" or "Biology_paper_1A_TZ1_HL.pdf"
    # or "Chemistry_paper_2__SL_markscheme.pdf"
    # Key pattern: contains "paper_" and (has "__" or has "_TZ" or has "_HL" or "_SL" or "markscheme")
    if "paper_" in name and (
        "__" in name or "_tz" in name or "_hl" in name or "_sl" in name
        or "markscheme" in name or "resource_booklet" in name
        or "text_booklet" in name or "question_booklet" in name
        or "data_booklet" in name or "reading_booklet" in name
    ):
        return "IB"
    return None


def get_plugin(path: Path) -> tuple[BoardPlugin, dict] | None:
    """Detect board + parse filename. Returns (plugin, metadata) or None."""
    board = detect_board(path)
    if not board:
        return None
    plugin = PLUGINS[board]
    meta = plugin.parse_filename(path)
    if not meta:
        return None
    return plugin, meta
