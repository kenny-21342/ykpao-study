"""Syllabus topic lists, keyed by the subject a run is narrowed to.

Stage 4 constrains the tagger to a supplied list and discards anything outside
it, so that a hallucinated topic can never reach the database
(`tag.py::_parse_tagging_response`). The list is a hard whitelist with no
fallback: supply nothing and *every* topic the model returns is dropped.

Nothing in the production path ever supplied one. `corpus_run.py` called
`run_corpus` without `subject_topics`, so the tagging pass ran on the whole
corpus, was billed for every question, and wrote zero topics -- which is
exactly what the store shows: 85,611 questions, 0 rows in
`bank_question_topics`. Downstream, the mock-exam Topics filter is hidden
because that table is empty.

So the list has to come from somewhere, and it has to be honest about what it
does not have. `topics_for` returns None rather than an empty list when a
subject is unknown, so the runner can tell "no topics configured" from "this
subject genuinely has none" and say so before spending anything.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import NamedTuple

_REGISTRY = Path(__file__).resolve().parent / "syllabus_topics.json"

_SEPARATORS = re.compile(r"[-_\s]+")


def _slug(text: str) -> str:
    return _SEPARATORS.sub("-", str(text).strip().lower()).strip("-")


def _load() -> dict[str, dict]:
    if not _REGISTRY.is_file():
        return {}
    try:
        raw = json.loads(_REGISTRY.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return {_slug(key): value for key, value in raw.items()}


def topics_for(subject: str | None) -> tuple[list[str], str] | None:
    """The syllabus topics and context for a subject, or None if unconfigured.

    `subject` is what `corpus_run --subject` accepts: a syllabus code (0625) or
    an IB subject slug (biology).
    """
    if not subject:
        return None
    entry = _load().get(_slug(subject))
    if not entry:
        return None
    topics = [str(topic) for topic in entry.get("topics", []) if str(topic).strip()]
    if not topics:
        return None
    return topics, str(entry.get("context") or subject)


class Syllabus(NamedTuple):
    topics: list[str]
    context: str
    #: "" for the subject's base list; otherwise names the era/level it was
    #: narrowed to, so a re-tag under a different list gets its own ledger key.
    variant: str


def syllabus_for(subject: str | None, year: int | None = None, level: str | None = None) -> Syllabus | None:
    """The topic list that applies to one paper: its syllabus era and level.

    A subject's syllabus changes (IB Physics was rewritten for first assessment
    in 2025: 2016-style "Mechanics" became "A.1 Kinematics" ...), and Standard
    level students do not study the Higher-level-only topics. Tagging a 2025 SL
    paper with the 2016 flat list, or an SL question with an HL-only topic, is
    wrong however confident the model is. `eras` (newest `from_year` that is not
    after `year`) and `hl_only` in the registry say which list applies.

    `level` is the subject row's: 'SL' drops the HL-only topics; 'HL' and the
    combined 'HLSL' keep every topic.
    """
    if not subject:
        return None
    entry = _load().get(_slug(subject))
    if not entry:
        return None
    variant = ""
    source = entry
    if year is not None:
        eras = sorted((e for e in entry.get("eras", []) if int(e.get("from_year", 9999)) <= year),
                      key=lambda e: int(e["from_year"]))
        if eras:
            source = eras[-1]
            variant = f"era{source['from_year']}"
    topics = [str(topic) for topic in source.get("topics", []) if str(topic).strip()]
    if not topics:
        return None
    if (level or "").upper() == "SL":
        hl_only = {str(topic) for topic in source.get("hl_only", [])}
        if hl_only:
            topics = [topic for topic in topics if topic not in hl_only]
            variant = f"{variant}-SL" if variant else "SL"
    return Syllabus(topics, str(source.get("context") or entry.get("context") or subject), variant)


def configured_subjects() -> list[str]:
    """Every subject the registry has a list for, for error messages."""
    return sorted(_load())
