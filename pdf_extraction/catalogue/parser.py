"""Parse past paper PDFs into catalogue rows.

Two naming conventions are supported:

CAIE  ``9709_s20_qp_52.pdf`` — everything is in the filename.
IB    ``Mathematics_analysis_and_approaches_paper_1__TZ1_HL.pdf`` — the filename
      carries subject/paper/timezone/level, while year and session come from the
      directory path (``2022 Examination Session/May 2022 Examination Session/``).

Subject names for CAIE are reused from ``pdf_extraction.lib.boards``.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.boards import CAIE_SUBJECTS  # noqa: E402


class ParseError(ValueError):
    """Raised when a PDF path cannot be mapped to a catalogue entry."""


# --- document types -------------------------------------------------------
# qp question paper, ms mark scheme, in insert, rb resource/source booklet,
# qb question booklet, tb text booklet, cs case study, au audio/listening.
QUESTION_PAPER = "qp"
MARK_SCHEME = "ms"

# Cambridge subject codes starting 0 are IGCSE, 9 are AS/A Level.
CAIE_QUALIFICATION_BY_PREFIX = {"0": "IGCSE", "9": "A Level"}

CAIE_SESSIONS = {"s", "w", "m"}

# The shared subject table bakes the level into some names ("Physics A-Level").
# Qualification is its own column here, so strip it back out for display.
_CAIE_LEVEL_SUFFIX = re.compile(r"\s*[-\s](?:A-Level|AS-Level|IGCSE)$", re.IGNORECASE)

_CAIE_PATTERN = re.compile(
    r"^(?P<code>\d{4})_(?P<session>[smw])(?P<year>\d{2})_"
    r"(?P<doctype>qp|ms|in|ci|sf|gt|sp|tn)_(?P<component>\d{1,2})\.pdf$",
    re.IGNORECASE,
)

# IB listening audio, shipped as loose tracks in an ``audio/`` directory beside
# the session's PDFs. Music is the only subject whose tracks are named this way;
# the language B and ab initio recordings in the same directories use coded
# names (``m23abengsliengtz0xxl.mp3``) and belong to subjects the school does
# not teach, so they are left unindexed rather than guessed at.
_IB_AUDIO_PATTERN = re.compile(r"^Track[ _]?(?P<track>\d+)\.mp3$", re.IGNORECASE)


def is_indexable_audio(path: Path) -> bool:
    """True for an audio file the catalogue knows how to place."""
    return bool(_IB_AUDIO_PATTERN.fullmatch(path.name))


_IB_PATTERN = re.compile(
    r"^(?P<subject>.+?)_paper_(?P<paper>\d+[A-Za-z]?)_+(?P<tail>.*?)\.pdf$",
    re.IGNORECASE,
)

# Music is the one IB subject filed without a "paper" token.
_IB_MUSIC_PATTERN = re.compile(
    r"^Music_+(?P<tail>.*?)\.pdf$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CatalogueEntry:
    """One PDF on disk, resolved to its place in the browse hierarchy."""

    board: str  # CAIE | IB
    qualification: str  # IGCSE | A Level | Diploma Programme
    subject_code: str  # "0625" or "ib-biology"
    subject_name: str
    year: int
    session: str  # CAIE: s|w|m   IB: may|nov
    paper_number: int
    paper_code: str  # raw token, e.g. "12" or "1A"
    variant: int  # CAIE variant digit; 0 when not applicable
    level: str  # IB only: HL | SL | HLSL
    timezone: str  # IB only: TZ1 | TZ2 | TZ3
    doc_type: str
    filename: str
    filepath: str  # relative to pdf_extraction/

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def instance_key(self) -> tuple:
        """Identity of the exam sitting, shared by its qp/ms/insert documents."""
        return (
            self.subject_code,
            self.year,
            self.session,
            self.paper_number,
            self.variant,
            self.level,
            self.timezone,
        )


def _relative_filepath(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


# --- CAIE -----------------------------------------------------------------

def parse_caie_path(path: Path, root: Path) -> CatalogueEntry:
    match = _CAIE_PATTERN.fullmatch(path.name)
    if not match:
        raise ParseError(f"Unrecognized CAIE filename: {path.name}")
    values = match.groupdict()

    code = values["code"]
    qualification = CAIE_QUALIFICATION_BY_PREFIX.get(code[0])
    if qualification is None:
        raise ParseError(f"Unknown CAIE subject code prefix: {code}")

    component = values["component"]
    paper_number = int(component[0])
    # Older syllabuses used a bare paper number with no variant digit.
    variant = int(component[1]) if len(component) > 1 else 0

    doc_type = values["doctype"].lower()
    if doc_type == "ci":
        doc_type = "in"

    return CatalogueEntry(
        board="CAIE",
        qualification=qualification,
        subject_code=code,
        subject_name=_CAIE_LEVEL_SUFFIX.sub("", CAIE_SUBJECTS.get(code, f"Subject {code}")),
        year=2000 + int(values["year"]),
        session=values["session"].lower(),
        paper_number=paper_number,
        paper_code=component,
        variant=variant,
        level="",
        timezone="",
        doc_type=doc_type,
        filename=path.name,
        filepath=_relative_filepath(path, root),
    )


# --- IB -------------------------------------------------------------------

def _ib_year_session(path: Path) -> tuple[int, str]:
    text = str(path)
    year_match = re.search(r"\b(20\d{2})\b", text)
    if not year_match:
        raise ParseError(f"IB path has no exam year: {path}")
    lowered = text.lower()
    # Check November first: "November 2019 Examination Session" also sits inside
    # a "2019 Examination Session" parent, and May must not shadow it.
    if "november" in lowered:
        session = "nov"
    elif "may" in lowered:
        session = "may"
    else:
        raise ParseError(f"IB path has no exam session: {path}")
    return int(year_match.group(1)), session


def _ib_level(tail: str, path: Path) -> str:
    # HLSL must be tested before HL/SL, otherwise it matches the prefix.
    for candidate in ("HLSL", "HL", "SL"):
        if re.search(rf"(?:^|_){candidate}(?:$|_)", tail, re.IGNORECASE):
            return candidate
    for candidate in ("HLSL", "HL", "SL"):
        if re.search(rf"(?:^|[ /_.-]){candidate}(?:$|[ /_.-])", str(path), re.IGNORECASE):
            return candidate
    return ""


def _ib_doc_type(tail: str) -> str:
    lowered = tail.lower()
    if "markscheme" in lowered or "mark_scheme" in lowered or "marking" in lowered:
        return MARK_SCHEME
    if "case_study" in lowered:
        return "cs"
    if "question_booklet" in lowered:
        return "qb"
    if "text_booklet" in lowered:
        return "tb"
    if "resource_booklet" in lowered or "source_booklet" in lowered or "score_booklet" in lowered:
        return "rb"
    if "data_booklet" in lowered or "reading_booklet" in lowered or "booklet" in lowered:
        return "rb"
    if "insert" in lowered:
        return "in"
    # A "listening paper" is the question paper itself. Its audio arrives as
    # separate mp3 tracks, indexed through `parse_ib_audio_path`.
    return QUESTION_PAPER


def _ib_subject_slug(subject_name: str) -> str:
    return "ib-" + re.sub(r"[^a-z0-9]+", "-", subject_name.lower()).strip("-")


# Words kept lowercase mid-title, and tokens that are acronyms rather than words.
_TITLE_MINOR_WORDS = {"a", "and", "of", "in", "the", "for", "to"}
_TITLE_ACRONYMS = {"itgs": "ITGS", "ib": "IB", "hl": "HL", "sl": "SL"}


def _title_case(name: str) -> str:
    words = name.split()
    out = []
    for index, word in enumerate(words):
        lowered = word.lower()
        if lowered in _TITLE_ACRONYMS:
            out.append(_TITLE_ACRONYMS[lowered])
        elif index > 0 and lowered in _TITLE_MINOR_WORDS:
            out.append(lowered)
        else:
            out.append(word[:1].upper() + word[1:].lower())
    return " ".join(out)


def parse_ib_path(path: Path, root: Path) -> CatalogueEntry:
    match = _IB_PATTERN.fullmatch(path.name)
    if match:
        values = match.groupdict()
        subject_name = re.sub(r"_+", " ", values["subject"]).strip()
        paper_code = values["paper"].upper()
        paper_number = int(re.match(r"\d+", paper_code).group(0))
        tail = values["tail"] or ""
    else:
        music = _IB_MUSIC_PATTERN.fullmatch(path.name)
        if not music:
            raise ParseError(f"Unrecognized IB filename: {path.name}")
        subject_name = "Music"
        paper_code = "listening"
        paper_number = 1
        tail = music.group("tail") or ""

    year, session = _ib_year_session(path)
    timezone_match = re.search(r"(?:tz|timezone)[_ -]?(\d+)", path.name, re.IGNORECASE)

    return CatalogueEntry(
        board="IB",
        qualification="Diploma Programme",
        subject_code=_ib_subject_slug(subject_name),
        subject_name=_title_case(subject_name),
        year=year,
        session=session,
        paper_number=paper_number,
        paper_code=paper_code,
        variant=0,
        level=_ib_level(tail, path),
        timezone=f"TZ{timezone_match.group(1)}" if timezone_match else "",
        doc_type=_ib_doc_type(tail),
        filename=path.name,
        filepath=_relative_filepath(path, root),
    )


# --- dispatch -------------------------------------------------------------

def parse_ib_audio_path(path: Path, root: Path) -> CatalogueEntry:
    """Place one Music listening track against its sitting.

    The tracks carry no subject or level in their names -- only "Track 3" -- so
    everything but the track number comes from where the file sits. That is
    sound for Music and nothing else, which is why `is_indexable_audio` gates
    this to the one naming convention.

    Level is HLSL because a single recording is played to both cohorts; it lands
    in the same sitting as the HLSL mark scheme and score booklet. The track
    number goes in `paper_code` rather than `variant`, since a variant would
    split each track into a sitting of its own and scatter the four of them
    across the browser.
    """
    match = _IB_AUDIO_PATTERN.fullmatch(path.name)
    if not match:
        raise ParseError(f"Unrecognized audio filename: {path.name}")

    year, session = _ib_year_session(path)
    return CatalogueEntry(
        board="IB",
        qualification="Diploma Programme",
        subject_code="ib-music",
        subject_name="Music",
        year=year,
        session=session,
        paper_number=1,
        paper_code="listening",
        variant=0,
        level="HLSL",
        timezone="",
        doc_type="au",
        filename=path.name,
        filepath=_relative_filepath(path, root),
    )


def parse_path(path: Path, root: Path) -> CatalogueEntry:
    """Parse a paper path, auto-detecting the board from its filename shape."""
    if path.suffix.lower() == ".mp3":
        return parse_ib_audio_path(path, root)
    if _CAIE_PATTERN.fullmatch(path.name):
        return parse_caie_path(path, root)
    return parse_ib_path(path, root)
