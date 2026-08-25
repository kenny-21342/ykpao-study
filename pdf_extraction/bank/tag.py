"""Stage 4 — tagging and difficulty, as a text-only pass.

Transcribed text goes to DeepSeek rather than a vision model: it is roughly an
order of magnitude cheaper per question and the input is already plain text.

Output is topics (syllabus-canonical), tags (what students actually search
for), skills (command words), and a difficulty rating with its reasoning.

The rubric is passed on every call rather than assumed, so ratings stay
comparable across subjects and across runs. ``difficulty_source`` on the row
records that this was a model estimate, leaving room to recalibrate from real
student attempt data later without losing the original.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .client import CallResult, ProviderError, call_json
from .env import text_settings

PROMPT_VERSION = "v4-tag-1"

DIFFICULTY_RUBRIC = """\
1 — Recall. One step: state a fact, or substitute directly into a formula that
    is given. No method choice.
2 — Routine. Two steps with one standard technique. The method is obvious from
    the wording. No case analysis.
3 — Method selection. Multi-step, and the candidate must choose the right
    technique from several plausible ones.
4 — Synthesis. Combines concepts from more than one topic, or presents a
    standard method in an unfamiliar framing.
5 — Extension. Extended reasoning, formal proof, or a genuinely novel setup
    that standard worked examples do not cover.\
"""

_SYSTEM_PROMPT = f"""\
You classify past-paper examination questions. You never answer them.

Given the text of one question, return a single JSON object describing it.

DIFFICULTY RUBRIC — apply exactly, and judge the work required of a candidate
sitting this paper, not how hard the topic sounds:
{DIFFICULTY_RUBRIC}

RULES
1. topics: choose ONLY from the supplied syllabus topic list, copying each
   string verbatim. If the list is empty or nothing fits, return [].
2. tags: 2-6 lowercase kebab-case terms a student would actually search for,
   naming the specific technique or concept ("maclaurin-series",
   "projectile-motion", "electromagnetic-induction"). Not generic words like
   "maths" or "hard".
3. skills: the command words the question actually uses ("calculate", "prove",
   "state", "explain"), lowercase.
4. difficulty: integer 1-5 from the rubric above.
5. difficulty_rationale: one short sentence naming the specific thing that sets
   the level, e.g. "requires integration by parts then a substitution".
6. confidence: your honest 0-1 estimate for this classification.

Return exactly this shape and nothing else:
{{"topics":[],"tags":[],"skills":[],"difficulty":3,"difficulty_rationale":"","confidence":0.9}}
"""

# Command words that appear across CAIE and IB papers, grouped by the demand
# they signal. Used for the deterministic pre-pass.
COMMAND_WORDS: set[str] = {
    # Recall / direct
    "state", "write", "list", "name", "give", "identify", "define", "label",
    # Routine procedure
    "calculate", "find", "determine", "solve", "show", "evaluate", "simplify",
    "expand", "factorise", "factorize", "plot", "sketch", "draw", "complete",
    "convert", "estimate", "measure",
    # Higher demand
    "prove", "derive", "justify", "explain", "describe", "compare", "analyse",
    "analyze", "discuss", "criticise", "criticize", "assess", "verify",
    "deduce", "suggest", "comment", "evaluate", "interpret",
}


@dataclass(frozen=True)
class TaggingResult:
    """Topics, tags, skills, and difficulty for one question."""

    topics: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    difficulty: int = 3
    difficulty_rationale: str = ""
    confidence: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "topics": self.topics,
            "tags": self.tags,
            "skills": self.skills,
            "difficulty": self.difficulty,
            "difficulty_rationale": self.difficulty_rationale,
            "confidence": self.confidence,
        }


def tag_and_rate(
    question_text: str,
    subject_topics: list[str] | None = None,
    subject_context: str | None = None,
    *,
    settings: dict[str, Any] | None = None,
    artifact_dir: Path | None = None,
) -> tuple[TaggingResult, CallResult]:
    """Classify one transcribed question.

    Returns the result together with the provider call so the caller can record
    real token usage in the ledger.
    """
    text = (question_text or "").strip()
    if not text:
        raise ValueError("question_text is empty")

    settings = settings or text_settings()
    topics = [str(topic) for topic in (subject_topics or [])]

    result = call_json(
        endpoint=settings["endpoint"],
        api_key=settings["api_key"],
        model=settings["model"],
        system_prompt=_SYSTEM_PROMPT,
        user_text=_build_user_text(text, topics, subject_context),
        image_paths=None,
        validator=_validate,
        max_attempts=settings.get("max_attempts", 3),
        timeout_seconds=settings.get("timeout_seconds", 180),
        artifact_dir=artifact_dir,
    )

    return _parse_tagging_response(result.content, allowed_topics=topics, source_text=text), result


def _build_user_text(
    question_text: str,
    subject_topics: list[str],
    subject_context: str | None,
) -> str:
    payload: dict[str, Any] = {
        "subject_context": subject_context or "unspecified",
        "syllabus_topics": subject_topics,
        "question_text": question_text,
    }
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


def _validate(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise ProviderError("response was not a JSON object")
    if "difficulty" not in payload:
        raise ProviderError("response is missing difficulty")
    try:
        difficulty = int(payload["difficulty"])
    except (TypeError, ValueError) as error:
        raise ProviderError("difficulty was not an integer") from error
    if not 1 <= difficulty <= 5:
        raise ProviderError(f"difficulty {difficulty} outside 1-5")


def _parse_tagging_response(
    content: dict[str, Any],
    *,
    allowed_topics: list[str],
    source_text: str,
) -> TaggingResult:
    """Coerce the reply, discarding anything the prompt did not license."""
    # Topic strings must match the syllabus list exactly, so a hallucinated
    # topic cannot reach the database.
    allowed = {topic.casefold(): topic for topic in allowed_topics}
    topics: list[str] = []
    for value in _string_list(content.get("topics")):
        canonical = allowed.get(value.casefold())
        if canonical and canonical not in topics:
            topics.append(canonical)

    tags: list[str] = []
    for value in _string_list(content.get("tags")):
        slug = _slugify(value)
        if slug and slug not in tags:
            tags.append(slug)

    # Command words are verifiable from the text, so the deterministic reading
    # is authoritative and the model's list only fills gaps.
    skills = extract_command_words(source_text)
    for value in _string_list(content.get("skills")):
        word = value.strip().casefold()
        if word in COMMAND_WORDS and word not in skills:
            skills.append(word)

    try:
        difficulty = int(content.get("difficulty", 3))
    except (TypeError, ValueError):
        difficulty = 3
    difficulty = max(1, min(5, difficulty))

    try:
        confidence = float(content.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    return TaggingResult(
        topics=topics,
        tags=tags[:6],
        skills=skills,
        difficulty=difficulty,
        difficulty_rationale=str(content.get("difficulty_rationale", "") or "").strip(),
        confidence=confidence,
    )


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().casefold()).strip("-")
    return slug


def extract_command_words(text: str) -> list[str]:
    """Command words present in the text, in order of first appearance."""
    found: list[str] = []
    seen: set[str] = set()
    for word in re.findall(r"\b[a-zA-Z]+\b", text.casefold()):
        if word in COMMAND_WORDS and word not in seen:
            found.append(word)
            seen.add(word)
    return found


def _build_tagging_prompt(
    question_text: str,
    subject_topics: list[str] | None,
    subject_context: str | None,
) -> str:
    """Full prompt text, retained for inspection and tests."""
    return _SYSTEM_PROMPT + "\n\n" + _build_user_text(
        question_text, [str(t) for t in (subject_topics or [])], subject_context
    )
