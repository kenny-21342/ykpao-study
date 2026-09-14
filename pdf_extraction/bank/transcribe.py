"""Stage 3 — VLM transcription, one call per root question.

The contract is deliberately flat:

    {
      "root_number": "7",
      "body_md": "The diagram shows...\\n\\n![](asset:fig1)\\n\\n**(a)** ...",
      "parts": [{"label": "a", "marks": 3}],
      "total_marks": 9,
      "figures_used": ["fig1"],
      "has_table": true,
      "confidence": 0.86,
      "notes": ""
    }

v3 asked for a recursive block tree and a cheap VLM could not emit it
reliably. Sub-parts here live inside ``body_md`` as ordinary formatted text;
``parts`` exists only for marks accounting and part-level filtering.

One call per root question bounds the token count absolutely, so v3's
1.4M-token overflow is structurally impossible.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .client import CallResult, ProviderError, call_json
from .env import vision_settings

PROMPT_VERSION = "v4-transcribe-1"

# Marks the reviewer should see rather than silently accept.
_MIN_CONFIDENCE = 0.0
_MAX_CONFIDENCE = 1.0


_QUESTION_SYSTEM_PROMPT = """\
You transcribe examination questions from images. You never answer them.

You are shown the image strips of ONE question from a past paper, in reading
order. Transcribe exactly what is printed. Return a single JSON object.

RULES
1. Transcribe only. Never solve, explain, correct, complete, or paraphrase.
   If the printed text contains an error, reproduce the error.
2. Output ONE record for the whole question. Sub-parts (a), (b)(ii) stay
   inside body_md as markdown, formatted as **(a)**, **(b)(ii)** on their own
   line before their text. Never split sub-parts into separate records.
3. Mathematics uses LaTeX: $...$ inline, $$...$$ display. Transcribe symbols
   faithfully; do not convert notation to a different convention.
4. Figures: you are given a figure inventory. Where a figure appears in the
   question, place ![](asset:ID) on its own line using an ID from that
   inventory. Never invent an ID. If no inventory entry matches, omit it.
5. Tables: emit a real HTML <table> inline in body_md, using colspan/rowspan
   where the printed table merges cells. Set has_table to true.
6. Ignore page furniture: barcodes, candidate name/number boxes, copyright
   lines, "Turn over", page numbers, and the dotted or blank answer rules that
   follow a question. Ignore blank answer space entirely.
7. Marks: each sub-part's mark allocation is printed as [3] at the end of that
   part. Record these in parts[] and their sum in total_marks. If the question
   has no sub-parts, parts is [] and total_marks is the question's own [n].
8. confidence is your own honest 0-1 estimate that this transcription is
   complete and correct. Use notes for anything unreadable or ambiguous.

Return exactly this shape and nothing else:
{"root_number":"<number>","body_md":"<markdown>","parts":[{"label":"a","marks":3}],
 "total_marks":9,"figures_used":["fig1"],"has_table":false,"confidence":0.9,"notes":""}
"""


_MARK_SCHEME_SYSTEM_PROMPT = """\
You transcribe examination MARK SCHEMES from images. You never re-derive them.

You are shown the image strips covering ONE question's mark scheme. Transcribe
exactly what is printed. Return a single JSON object.

RULES
1. Transcribe only. Never invent, complete, or "improve" a marking point.
2. Output ONE record for the whole question, covering every sub-part. Keep the
   sub-part structure inside answer_md as markdown, e.g. **(a)** then its
   marking detail.
3. Mathematics uses LaTeX: $...$ inline, $$...$$ display.
4. marking_points[] captures the award codes in printed order. mark_code is the
   printed code (M1, A1, B1, DM1, FT, SC, OE, ISW...). marks is its integer
   value. text is the condition being rewarded. alternatives holds accepted
   variants ("or", "OE", "accept ...") as a list of strings.
5. Guidance and notes columns belong in answer_md, not in marking_points.
6. total_marks is the printed total for the question.
7. If this mark scheme is a multiple-choice key, set answer_letter to the
   single printed letter and keep answer_md short.
8. confidence is your honest 0-1 estimate. Use notes for anything unreadable.

Return exactly this shape and nothing else:
{"root_number":"<number>","answer_md":"<markdown>",
 "marking_points":[{"mark_code":"M1","marks":1,"text":"...","alternatives":[]}],
 "total_marks":9,"answer_letter":null,"confidence":0.9,"notes":""}
"""


@dataclass(frozen=True)
class QuestionTranscription:
    """Flat transcription of one root question."""

    root_number: str
    body_md: str
    parts: list[dict[str, Any]]
    total_marks: int | None
    figures_used: list[str]
    has_table: bool
    confidence: float
    notes: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "root_number": self.root_number,
            "body_md": self.body_md,
            "parts": self.parts,
            "total_marks": self.total_marks,
            "figures_used": self.figures_used,
            "has_table": self.has_table,
            "confidence": self.confidence,
            "notes": self.notes,
        }


@dataclass(frozen=True)
class MarkSchemeTranscription:
    """Flat transcription of one root question's mark scheme."""

    root_number: str
    answer_md: str
    marking_points: list[dict[str, Any]]
    total_marks: int | None
    answer_letter: str | None
    confidence: float
    notes: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "root_number": self.root_number,
            "answer_md": self.answer_md,
            "marking_points": self.marking_points,
            "total_marks": self.total_marks,
            "answer_letter": self.answer_letter,
            "confidence": self.confidence,
            "notes": self.notes,
        }


class TooManyStrips(RuntimeError):
    """More strips than the provider will accept in one call.

    Terminal for this provider: retrying cannot help, and truncating the strip
    list would silently drop part of the question. Recorded as `skipped` so the
    paper can still be counted finished -- see RunLedger.record_failure.
    """


def transcribe_question(
    rendered_span,
    doc_type: str = "qp",
    *,
    settings: dict[str, Any] | None = None,
    artifact_dir: Path | None = None,
) -> tuple[QuestionTranscription | MarkSchemeTranscription, CallResult]:
    """Transcribe one rendered span.

    ``rendered_span`` is a :class:`~pdf_extraction.bank.renderer.RenderedSpan`;
    its strips are the images sent and its figures are the only asset ids the
    model may cite.
    """
    image_paths = list(rendered_span.image_paths)
    if not image_paths:
        raise ValueError(f"root {rendered_span.root_number} has no rendered strips")

    settings = settings or vision_settings()

    # Refuse here rather than let the provider refuse three times. Sending the
    # first `max_images` strips instead would be worse than failing: a question
    # missing its last page still parses, still validates, and still reads as a
    # complete question -- there is nothing downstream that could tell it was
    # truncated.
    max_images = int(settings.get("max_images") or 0)
    if max_images and len(image_paths) > max_images:
        raise TooManyStrips(
            f"root {rendered_span.root_number} has {len(image_paths)} strips; "
            f"this provider accepts at most {max_images} images per call"
        )
    root_number = rendered_span.root_number
    is_mark_scheme = doc_type == "ms"

    system_prompt = _MARK_SCHEME_SYSTEM_PROMPT if is_mark_scheme else _QUESTION_SYSTEM_PROMPT
    user_text = _build_user_text(rendered_span, doc_type)

    result = call_json(
        endpoint=settings["endpoint"],
        api_key=settings["api_key"],
        model=settings["model"],
        system_prompt=system_prompt,
        user_text=user_text,
        image_paths=image_paths,
        validator=lambda payload: _validate(payload, root_number, is_mark_scheme),
        max_attempts=settings.get("max_attempts", 3),
        timeout_seconds=settings.get("timeout_seconds", 300),
        # A mark scheme has many marking points and generates far more text
        # than a question, enough to run past the read timeout unbounded.
        max_tokens=3000 if is_mark_scheme else 1600,
        artifact_dir=artifact_dir,
    )

    if is_mark_scheme:
        transcription = _parse_mark_scheme_response(result.content, root_number)
    else:
        transcription = _parse_question_response(result.content, root_number)

    known_ids = {figure["id"] for figure in rendered_span.figures}
    return _post_process_transcription(transcription, known_figure_ids=known_ids), result


def _ordinals_by_page(figures) -> list[int]:
    """Position of each figure within its own page, counting from 1."""
    seen: dict[Any, int] = {}
    ordinals: list[int] = []
    for figure in figures:
        page = figure["page"]
        seen[page] = seen.get(page, 0) + 1
        ordinals.append(seen[page])
    return ordinals


def _build_user_text(rendered_span, doc_type: str) -> str:
    """Describe the job in JSON alongside the images.

    The inventory carries each figure's *position*, not just its id. The model
    is shown page strips rather than the individual crops, so an id it cannot
    locate on the page is an id it can only guess at — and it guesses
    confidently. Ordinal plus page lets it pair "the first figure on page 4"
    with `fig1`, which the renderer now guarantees is the topmost one.
    """
    inventory = [
        {
            "id": figure["id"],
            "page": figure["page"],
            "kind": figure.get("kind", "figure"),
            # 1 = first down the page, matching the order they appear in the
            # strips the model is looking at.
            "order_on_page": ordinal,
        }
        for figure, ordinal in zip(rendered_span.figures, _ordinals_by_page(rendered_span.figures))
    ]
    payload = {
        "task": "transcribe-one-root-question",
        "doc_type": doc_type,
        "root_number": rendered_span.root_number,
        "page_range": [rendered_span.page_start, rendered_span.page_end],
        "image_count": len(rendered_span.strips),
        "figure_inventory": inventory,
        "instructions": (
            "The images are the strips of this one question in reading order. "
            "Transcribe the whole question as a single record. "
            + (
                "Figure ids run in reading order down each page: on any page, "
                "order_on_page 1 is the topmost figure, 2 the next below it, "
                "and so on. Match each figure you see to the id with its "
                "page and position -- do not guess from the caption number, "
                "which does not always start at 1. You may only cite these "
                "figure ids: "
                + ", ".join(figure["id"] for figure in inventory)
                if inventory
                else "There is no figure inventory, so figures_used must be []."
            )
        ),
    }
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


def _validate(payload: dict[str, Any], root_number: int, is_mark_scheme: bool) -> None:
    """Reject a reply that cannot become a row, so the call retries."""
    if not isinstance(payload, dict):
        raise ProviderError("response was not a JSON object")

    body_field = "answer_md" if is_mark_scheme else "body_md"
    body = payload.get(body_field)
    if not isinstance(body, str) or not body.strip():
        raise ProviderError(f"{body_field} is missing or empty")

    reported = str(payload.get("root_number", "")).strip()
    # A digit-only comparison keeps "7", "7.", and "Question 7" all acceptable.
    reported_digits = re.sub(r"\D", "", reported)
    if reported_digits and reported_digits != str(root_number):
        raise ProviderError(
            f"root_number mismatch: asked for {root_number}, model returned {reported!r}"
        )


def _parse_question_response(content: dict[str, Any], expected_root: int) -> QuestionTranscription:
    """Coerce a raw reply into a QuestionTranscription."""
    if not isinstance(content, dict):
        raise ProviderError("Response is not a JSON object")

    body_md = str(content.get("body_md", "") or "")
    if not body_md.strip():
        raise ProviderError("body_md is empty")

    parts = content.get("parts")
    if not isinstance(parts, list):
        parts = []

    figures_used = content.get("figures_used")
    if not isinstance(figures_used, list):
        figures_used = []

    return QuestionTranscription(
        root_number=str(expected_root),
        body_md=body_md,
        parts=parts,
        total_marks=_optional_int(content.get("total_marks")),
        figures_used=[str(value) for value in figures_used],
        has_table=bool(content.get("has_table", False)),
        confidence=_clamp_confidence(content.get("confidence")),
        notes=str(content.get("notes", "") or ""),
    )


def _parse_mark_scheme_response(
    content: dict[str, Any],
    expected_root: int,
) -> MarkSchemeTranscription:
    """Coerce a raw reply into a MarkSchemeTranscription."""
    if not isinstance(content, dict):
        raise ProviderError("Response is not a JSON object")

    answer_md = str(content.get("answer_md", "") or "")
    if not answer_md.strip():
        raise ProviderError("answer_md is empty")

    marking_points = content.get("marking_points")
    if not isinstance(marking_points, list):
        marking_points = []

    answer_letter = content.get("answer_letter")
    if answer_letter is not None:
        answer_letter = str(answer_letter).strip().upper() or None

    return MarkSchemeTranscription(
        root_number=str(expected_root),
        answer_md=answer_md,
        marking_points=marking_points,
        total_marks=_optional_int(content.get("total_marks")),
        answer_letter=answer_letter,
        confidence=_clamp_confidence(content.get("confidence")),
        notes=str(content.get("notes", "") or ""),
    )


def _post_process_transcription(
    transcription: QuestionTranscription | MarkSchemeTranscription,
    *,
    known_figure_ids: set[str] | None = None,
) -> QuestionTranscription | MarkSchemeTranscription:
    """Normalise whitespace and drop anything that cannot be trusted.

    v3 instructed the model to produce clean prose and then rejected the whole
    document when it did not. Cleaning it here is cheaper and cannot lose work.
    """
    if isinstance(transcription, QuestionTranscription):
        body = _normalize_whitespace(transcription.body_md)

        # Some models cite a figure as a bare `asset:fig1` rather than the
        # `![](asset:fig1)` rule 4 asks for -- Qwen3-VL never did, Sonnet does
        # it every time. Everything downstream matches the markdown form: the
        # unknown-id strip below, `_ASSET_CITATION` in qa.py, and the renderer.
        # So a bare citation is not a cosmetic difference -- it renders to the
        # student as the literal text `asset:fig1`, and it makes the figure QA
        # check blind, which is the check that catches a confidently wrong
        # citation. Normalising is deterministic and cannot lose work; the
        # lookbehind leaves an already-correct citation alone.
        body = re.sub(r"(?<!\]\()\basset:([A-Za-z0-9_-]+)", r"![](asset:\1)", body)

        # A placeholder the inventory does not contain would render as a broken
        # image, so strip it and keep only ids that resolve.
        cited = set(re.findall(r"!\[[^\]]*\]\(asset:([A-Za-z0-9_-]+)\)", body))
        allowed = set(transcription.figures_used)
        if known_figure_ids is not None:
            allowed &= known_figure_ids
            for unknown in cited - known_figure_ids:
                body = re.sub(
                    rf"!\[[^\]]*\]\(asset:{re.escape(unknown)}\)\s*", "", body
                )
            cited &= known_figure_ids

        return QuestionTranscription(
            root_number=transcription.root_number,
            body_md=body,
            parts=_validated_parts(transcription.parts),
            total_marks=transcription.total_marks,
            # Trust the body over the model's own list: an id it claimed but
            # never placed is not actually used.
            figures_used=sorted(cited | (allowed & cited)) if cited else sorted(allowed),
            has_table=transcription.has_table or "<table" in body.lower(),
            confidence=transcription.confidence,
            notes=transcription.notes,
        )

    return MarkSchemeTranscription(
        root_number=transcription.root_number,
        answer_md=_normalize_whitespace(transcription.answer_md),
        marking_points=_validated_marking_points(transcription.marking_points),
        total_marks=transcription.total_marks,
        answer_letter=transcription.answer_letter,
        confidence=transcription.confidence,
        notes=transcription.notes,
    )


def _validated_parts(parts: list[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        label = str(part.get("label", "") or "").strip()
        if not label:
            continue
        result.append({"label": label, "marks": _optional_int(part.get("marks"))})
    return result


def _validated_marking_points(points: list[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for point in points:
        if not isinstance(point, dict):
            continue
        mark_code = str(point.get("mark_code", "") or "").strip()
        if not mark_code:
            continue
        marks = point.get("marks")
        if marks is not None:
            try:
                marks = int(marks)
            except (TypeError, ValueError):
                # A non-numeric mark value means the row was misread; dropping
                # it keeps the marks total honest.
                continue
        alternatives = point.get("alternatives")
        if not isinstance(alternatives, list):
            alternatives = []
        result.append({
            "mark_code": mark_code,
            "marks": marks,
            "text": str(point.get("text", "") or ""),
            "alternatives": [str(value) for value in alternatives],
        })
    return result


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _clamp_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return 0.5
    if confidence < _MIN_CONFIDENCE or confidence > _MAX_CONFIDENCE:
        return 0.5
    return confidence


# Control characters that a JSON decoder produces from a single-escaped LaTeX
# command, mapped back to the backslash sequence that was meant.
_LATEX_ESCAPE_RECOVERY = {
    "\f": r"\f",   # \frac, \forall
    "\t": r"\t",   # \theta, \text, \times, \tan
    "\b": r"\b",   # \beta, \binom
    "\v": r"\v",   # \vec, \varphi
}

_MATH_SPAN_RE = re.compile(r"\$\$.+?\$\$|\$[^$]+?\$", re.DOTALL)


def _restore_latex_escapes(text: str) -> str:
    """Undo JSON escape damage inside mathematics.

    A model that emits ``"$\\frac{a}{b}$"`` with a single backslash produces
    valid JSON whose decoded value contains a formfeed followed by ``rac`` —
    ``\\f`` and ``\\t`` are legal JSON escapes. The whitespace normaliser then
    collapses the tab to a space, turning ``\\theta`` into a stray ``heta``,
    and the formula silently renders as prose.

    Recovery is confined to ``$...$`` spans: a literal tab in ordinary prose is
    just whitespace and must not become the characters ``\\t``.
    """
    if not any(char in text for char in _LATEX_ESCAPE_RECOVERY):
        return text

    def repair(match: re.Match[str]) -> str:
        span = match.group(0)
        for char, replacement in _LATEX_ESCAPE_RECOVERY.items():
            span = span.replace(char, replacement)
        return span

    return _MATH_SPAN_RE.sub(repair, text)


def has_damaged_latex(text: str) -> bool:
    """True when mathematics still holds control characters after recovery."""
    return any(
        char in match.group(0)
        for match in _MATH_SPAN_RE.finditer(text)
        for char in _LATEX_ESCAPE_RECOVERY
    )


def _normalize_whitespace(text: str) -> str:
    """Tidy model markdown without changing its meaning.

    Collapses horizontal runs, removes line-break hyphenation, and reduces any
    run of blank lines to exactly one.
    """
    text = _restore_latex_escapes(text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
