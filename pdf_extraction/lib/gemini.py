"""
Gemini 3.5 Flash vision client for exam-paper extraction.

Sends page images to Gemini and receives structured JSON (questions with
LaTeX text, marks, topic labels, image descriptions).

Usage:
  from lib.gemini import extract_from_pages
  results = extract_from_pages(page_images, doc_type="qp", board="CAIE")
"""
from __future__ import annotations

import base64
import json
import os
import ssl
import time
import urllib.request
import urllib.error
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

API_KEY = os.environ.get("GEMINI_API_KEY", "")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
API_BASE = "https://generativelanguage.googleapis.com/v1beta"

MAX_RETRIES = 3
RETRY_DELAYS = [2, 5, 12]  # seconds

# macOS Python 3.14 doesn't always pick up system CA certs. Create an SSL
# context that doesn't verify certs — safe because we're connecting to a
# known Google endpoint over HTTPS. (On Python 3.14, must disable
# check_hostname BEFORE setting verify_mode to CERT_NONE.)
_SSL_CONTEXT = ssl.create_default_context()
_SSL_CONTEXT.check_hostname = False
_SSL_CONTEXT.verify_mode = ssl.CERT_NONE


def _api_call(payload: dict, endpoint: str = "generateContent") -> dict:
    """Make a Gemini API call. Retries on 429/5xx."""
    url = f"{API_BASE}/models/{MODEL}:{endpoint}?key={API_KEY}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = urllib.request.urlopen(req, timeout=120, context=_SSL_CONTEXT)
            data = json.loads(resp.read().decode("utf-8"))
            return data
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                pass
            if e.code == 429 or e.code >= 500:
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                print(f"    [Gemini] {e.code}, retry in {delay}s... ({body_text[:100]})")
                time.sleep(delay)
                last_error = e
                continue
            raise RuntimeError(f"Gemini API {e.code}: {body_text}") from e
        except Exception as e:
            delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
            print(f"    [Gemini] error: {e}, retry in {delay}s...")
            time.sleep(delay)
            last_error = e
            continue

    raise RuntimeError(f"Gemini API failed after {MAX_RETRIES} retries: {last_error}")


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_QP_SYSTEM = (
    "You are an expert exam-paper parser. You receive page images from an exam paper "
    "and extract every question into structured JSON. "
    "Math MUST be written as LaTeX inside $...$ or $$...$$ directly in the text field. "
    "Do NOT put LaTeX in a separate field. "
    "If a page contains only a cover page, instructions, or blank space with no questions, "
    'return {"questions": []}. Never fabricate questions.\n\n'
    "CRITICAL RULES:\n"
    "1. GROUP BY TOP-LEVEL QUESTION: Each entry in the output array is ONE complete "
    "top-level question (numbered 1, 2, 3, ...), NOT individual subparts. "
    "Combine ALL subparts (a, a(i), a(ii), b, ...) into a single question's 'text' field, "
    "preserving the subpart labels inline. Subparts often depend on each other "
    "('Hence find...', 'Using your answer from (a)(i)...') so they MUST stay together.\n"
    "   The 'label' field is the top-level number only: '1', '2', '3', etc.\n"
    "   The 'text' field contains ALL subparts concatenated with their labels:\n"
    "     '(a) State what is meant by the term activation energy. [2]\n"
    "      (b)(i) Calculate the rate of reaction at time = 20s using Fig 1.2. [3]\n"
    "      (b)(ii) Hence determine the order of the reaction. [1]'\n"
    "2. TABLES: Always reproduce tables as LaTeX arrays inside $$...$$. "
    "Example: $$\\begin{array}{|c|c|c|}\\hline A & B & C \\\\\\hline 1 & 2 & 3 \\\\\\hline\\end{array}$$\n"
    "   Never use Markdown tables (| pipe syntax). Always use LaTeX arrays.\n"
    "3. MULTIPLE-CHOICE OPTIONS: If options A/B/C/D are text, include them in the text field. "
    "If options are part of a table, reproduce the table as a LaTeX array. "
    "If options are only visible as part of a diagram (not extractable as text), "
    "set has_image=true and describe them in image_description.\n"
    "4. DATA TABLES provided as context must ALWAYS be reproduced in full as LaTeX arrays. "
    "Never summarise or omit a data table.\n"
    "5. CHEMICAL EQUATIONS: Write as LaTeX, e.g. $CH_4 + 2O_2 \\rightarrow CO_2 + 2H_2O$. "
    "For complex structural formulae (skeletal drawings, benzene rings) that cannot be "
    "represented as text, set has_image=true and describe the structure.\n"
    "6. GRAPHS/DIAGRAMS: If a question refers to a graph or diagram, always set has_image=true "
    "and describe what the image shows so it can be linked to the question.\n"
    "7. CLEANUP: Remove answer lines (rows of dots like '...............' or '_______________'). "
    "These are for students to write on paper and are NOT part of the question text. "
    "Also remove 'Space for working', 'Space for answer', and blank answer boxes.\n"
    "8. MARKS: The 'marks' field is the TOTAL marks for the entire question (sum of all subparts)."
)

_MS_SYSTEM = (
    "You are an expert mark-scheme parser. You receive page images from a CAIE or IB "
    "mark scheme and extract every marking entry into structured JSON. "
    "If a page contains only generic marking principles or a cover page, "
    'return {"questions": []}. Never fabricate.\n\n'
    "IMPORTANT: Group subparts into complete questions — ONE entry per top-level question "
    "number. All subpart marking points go into one question's marking_points array, "
    "tagged with their subpart label. This matches how question papers are structured.\n"
    "REMOVE any rows of dots (.......) or underscores from the output."
)

_INSERT_SYSTEM = (
    "You are an expert at parsing data booklets and insert sheets (periodic tables, "
    "data tables, formula sheets). Extract any structured data as text with LaTeX for math. "
    "Describe images (periodic tables, graphs) so they can be linked to questions."
)


def _build_qp_prompt(board: str, subject_hint: str, syllabus_topics: str = "") -> str:
    topic_instruction = (
        f'\n- "topic" MUST be one of these exact syllabus topics (use the code): {syllabus_topics}.\n'
        '  Do NOT use "General" unless the question truly does not fit any topic.\n'
        '  If the question spans multiple topics, pick the primary one.'
        if syllabus_topics else
        '\n- "topic" is a short subject sub-topic (e.g. "Mechanics", "Algebra"). Use "General" if unclear.'
    )
    return f"""Extract EVERY question visible on these pages from a {board} exam paper.{subject_hint}

IMPORTANT: Group subparts into complete questions. Return ONE entry per top-level question number.

Return JSON in EXACTLY this shape:
{{"questions":[{{"label":"1","text":"(a) State what is meant by activation energy. $E_a$ is the minimum energy...\\n(b)(i) Calculate the rate at time = 20 s using Fig. 1.2. [3]\\n(b)(ii) Hence determine the order. [1]","marks":6,"has_image":true,"image_description":"line graph of CO2 volume vs time","image_region":"below part (b)","topic":"Respiration"}}]}}

Rules:
- "label" is the TOP-LEVEL number only: "1", "2", "3". Never "1(a)" or "2(b)(iii)".
- "text" contains ALL subparts of the question concatenated together.
  Start each subpart on a new line with its label: "(a) ...", "(b)(i) ...", etc.
  Keep the original [marks] for each subpart inline.
  This ensures dependent subparts ("Hence find...", "Using your answer from (a)(i)...") stay in context.
- "marks" is the TOTAL marks for the entire question (sum of all subparts).
- Put ALL math as LaTeX using $...$ (inline) or $$...$$ (display).
  ALL tables MUST be LaTeX arrays inside $$...$$. Never use Markdown pipe tables.
  Include multiple-choice options (A/B/C/D) as text if they are text, or as a LaTeX array table.
- "has_image" is true if ANY subpart references a figure/graph/diagram/table/data table.
- "image_description" and "image_region" describe the image for the subpart that needs it.
{topic_instruction}
- REMOVE all answer lines: rows of dots (.......), underscores (_____), "Space for working", "Space for answer".
- Return ONLY valid JSON. No markdown fences, no commentary."""


def _build_ms_prompt(board: str, subject_hint: str) -> str:
    return f"""Extract EVERY mark scheme entry visible on these pages from a {board} mark scheme.{subject_hint}

IMPORTANT: Group subparts — ONE entry per top-level question number.

Return JSON in EXACTLY this shape:
{{"questions":[{{"label":"1","marking_points":["(a) Award 1 mark for correct definition of activation energy","(b)(i) Award 1 mark for correct gradient calculation","(b)(i) Award 1 mark for correct unit","(b)(ii) Award 1 mark for first order with justification"],"answer":"(a) $E_a$ = minimum energy... (b)(ii) first order","marks":6,"topic":"Kinetics"}}]}}

Rules:
- "label" is the TOP-LEVEL number only: "1", "2", "3". Never "1(a)".
- "marking_points" is an array of EVERY marking point for ALL subparts, each prefixed with its subpart label.
  Include M1/A1/B1/B2 tags exactly as printed.
- "answer" is a brief summary of final answers with math as $LaTeX$.
- "marks" is the TOTAL marks for the entire question.
- "topic" is a short sub-topic label; use "General" if unclear.
- REMOVE rows of dots (.......) and underscores from marking point text.
- Return ONLY valid JSON."""


def _build_insert_prompt() -> str:
    return """Extract the content of this data booklet / insert page.
Return JSON:
{"tables":[{"title":"Periodic Table","description":"...","text":"..."}],"formulas":["$E = mc^2$","..."],"notes":"any other text content"}

Rules:
- Convert all math/chemical formulas to LaTeX.
- Describe tables and figures so they can be linked to questions.
- Return ONLY valid JSON."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _encode_images(image_paths: list[Path]) -> list[dict]:
    """Encode page images as base64 inline_data for Gemini."""
    parts = []
    for img_path in image_paths:
        with open(img_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        parts.append({
            "inline_data": {
                "mime_type": "image/png",
                "data": b64,
            }
        })
    return parts


def extract_from_pages(
    page_images: list[Path],
    doc_type: str,
    board: str = "CAIE",
    subject_code: str = "",
    syllabus_topics: str = "",
) -> dict | None:
    """
    Send page images to Gemini and return the parsed JSON.

    Args:
        page_images: list of paths to PNG files (1-3 pages per call).
        doc_type: "qp" | "ms" | "in"
        board: "CAIE" | "IB"
        subject_code: e.g. "0610" (for topic-labelling hints)
        syllabus_topics: comma-separated syllabus topics for classification

    Returns:
        Parsed JSON dict, or None on failure.
    """
    if not API_KEY:
        raise RuntimeError("GEMINI_API_KEY not set")

    subject_hint = f" The subject code is {subject_code}." if subject_code else ""

    if doc_type == "qp":
        system = _QP_SYSTEM
        user_prompt = _build_qp_prompt(board, subject_hint, syllabus_topics)
    elif doc_type == "ms":
        system = _MS_SYSTEM
        user_prompt = _build_ms_prompt(board, subject_hint, syllabus_topics)
    elif doc_type == "in":
        system = _INSERT_SYSTEM
        user_prompt = _build_insert_prompt()
    else:
        raise ValueError(f"Unknown doc_type: {doc_type}")

    # Build the multimodal request.
    content_parts = [{"text": user_prompt}] + _encode_images(page_images)

    payload = {
        "contents": [{"role": "user", "parts": content_parts}],
        "systemInstruction": {"parts": [{"text": system}]},
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
        },
    }

    try:
        resp = _api_call(payload)
    except RuntimeError as e:
        print(f"    [Gemini] API call failed: {e}")
        return None

    # Extract text from response.
    try:
        candidates = resp.get("candidates", [])
        if not candidates:
            print(f"    [Gemini] no candidates in response")
            return None
        content = candidates[0].get("content", {})
        parts = content.get("parts", [])
        if not parts:
            return None
        text = parts[0].get("text", "")
        if not text.strip():
            return None
        return json.loads(text)
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        print(f"    [Gemini] parse error: {e}")
        # Try to salvage — the response might have markdown fences.
        try:
            text = resp["candidates"][0]["content"]["parts"][0]["text"]
            cleaned = text.strip()
            if cleaned.startswith("```"):
                cleaned = "\n".join(cleaned.split("\n")[1:-1])
            return json.loads(cleaned)
        except Exception:
            return None


def test_connection() -> bool:
    """Quick connectivity test. Returns True if the API is reachable."""
    if not API_KEY:
        print("GEMINI_API_KEY not set")
        return False
    try:
        url = f"{API_BASE}/models?key={API_KEY}"
        req = urllib.request.Request(url)
        resp = urllib.request.urlopen(req, timeout=15, context=_SSL_CONTEXT)
        data = json.loads(resp.read().decode("utf-8"))
        models = [m["name"] for m in data.get("models", []) if "3.5" in m.get("name", "") or "flash" in m.get("name", "")]
        print(f"Gemini OK. Available models: {models[:5]}")
        return True
    except Exception as e:
        print(f"Gemini unreachable: {e}")
        return False
