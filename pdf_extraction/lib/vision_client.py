"""
Vision client for exam-paper extraction.

Supports two backends:
  1. SiliconFlow (OpenAI-compatible API) — China-accessible, WeChat/Alipay
  2. Gemini (Google native API) — requires VPN

Backend is selected automatically based on which API key is set:
  - If a SiliconFlow key is set    → use SiliconFlow
    (SILICONFLOW_API_KEY, or V3_OPENAI_API_KEY as an alias — see _siliconflow_key)
  - Else if GEMINI_API_KEY is set  → use Gemini
  - Else error

SiliconFlow models (set via VISION_MODEL env var):
  - "Qwen/Qwen3-VL-32B-Instruct"   (recommended — best vision quality, ¥4/1M)
  - "Qwen/Qwen3.5-35B-A3B"         (cheapest vision, ¥0.40/1M)
  - "Qwen/Qwen3-VL-8B-Instruct"    (fastest, lower quality)

Usage:
  from lib.vision_client import extract_from_pages, test_connection
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
from typing import Any

# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------

def _siliconflow_key() -> str:
    """
    The project's one SiliconFlow key, under either of the two names it has.

    SILICONFLOW_API_KEY is canonical and is what this module, lib/vision.ts and
    the web app's OCR path read. The V3 batch scripts under scripts/ hold the
    same key as V3_OPENAI_API_KEY, so accept that as an alias — but only when
    the pipeline endpoint is (or defaults to) SiliconFlow, because a key for a
    different OpenAI-compatible provider must never be sent to SF_BASE.
    """
    direct = os.environ.get("SILICONFLOW_API_KEY", "")
    if direct:
        return direct
    endpoint = os.environ.get("V3_OPENAI_CHAT_COMPLETIONS_URL", "")
    if endpoint and "api.siliconflow.cn" not in endpoint:
        return ""
    return os.environ.get("V3_OPENAI_API_KEY", "")


SILICONFLOW_KEY = _siliconflow_key()
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")

# SiliconFlow config
SF_BASE = "https://api.siliconflow.cn/v1/chat/completions"
SF_MODEL = os.environ.get("VISION_MODEL", "Qwen/Qwen3-VL-32B-Instruct")

# Gemini config
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"

MAX_RETRIES = 5
RETRY_DELAYS = [2, 5, 12, 20, 30]

# SSL context for macOS Python 3.14 (doesn't pick up system CA certs)
_SSL_CONTEXT = ssl.create_default_context()
_SSL_CONTEXT.check_hostname = False
_SSL_CONTEXT.verify_mode = ssl.CERT_NONE

BACKEND = "siliconflow" if SILICONFLOW_KEY else ("gemini" if GEMINI_KEY else None)


# ---------------------------------------------------------------------------
# Prompts (shared across backends)
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
    "REMOVE any rows of dots (.......) or underscores from the output.\n\n"
    "SPECIAL CASE — IB PAPER 1 ANSWER KEYS: If the page is a simple answer key grid "
    "(just question numbers with single-letter answers like '1. B', '2. A'), return each "
    "answer as its own entry with marking_points=['B'] and answer='B'. Do NOT skip these "
    "even though they are short — they are the mark scheme for Paper 1 multiple choice."
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
  Put ALL math as LaTeX using $...$ (inline) or $$...$$ (display).
  ALL tables MUST be LaTeX arrays inside $$...$$. Never use Markdown pipe tables.
  Include multiple-choice options (A/B/C/D) as text if they are text, or as a LaTeX array table.
- "marks" is the TOTAL marks for the entire question (sum of all subparts).
- "has_image" is true if ANY subpart references a figure/graph/diagram/table/data table.
- "image_description" and "image_region" describe the image for the subpart that needs it.
{topic_instruction}
- REMOVE all answer lines: rows of dots (.......), underscores (_____), "Space for working", "Space for answer".
- Return ONLY valid JSON. No markdown fences, no commentary."""


def _build_ms_prompt(board: str, subject_hint: str, syllabus_topics: str = "") -> str:
    return f"""Extract EVERY mark scheme entry visible on these pages from a {board} mark scheme.{subject_hint}

IMPORTANT: There are TWO types of mark scheme pages. Handle BOTH:

TYPE 1 — DETAILED MARKING (Paper 2, Paper 3, CAIE structured questions):
Extract detailed marking points with M1/A1/B1 tags.
Group subparts — ONE entry per top-level question number.

TYPE 2 — ANSWER KEY GRID (IB Paper 1 multiple choice):
If the page shows a simple grid of question numbers with single-letter answers
(e.g. "1. B  2. A  3. C  4. D"), extract EACH answer as a separate entry.

Return JSON in EXACTLY this shape:
{{"questions":[{{"label":"1","marking_points":["(a) Award 1 mark for correct definition of activation energy","(b)(i) Award 1 mark for correct gradient calculation"],"answer":"(a) $E_a$ = minimum energy... (b)(ii) first order","marks":6,"topic":"Kinetics"}}]}}

For TYPE 2 answer keys, each entry looks like:
{{"label":"1","marking_points":["B"],"answer":"B","marks":1,"topic":"General"}}

Rules:
- "label" is the question number: "1", "2", etc.
- "marking_points" is an array of EVERY marking point, prefixed with subpart label.
- For answer-key grids, marking_points is just ["B"] or ["C"] etc.
- "answer" is the final answer with math as $LaTeX$.
- "marks" is the total marks.
- "topic" is a short sub-topic label; use "General" if unclear.
- REMOVE rows of dots (.......) and underscores.
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
# Backend 1: SiliconFlow (OpenAI-compatible)
# ---------------------------------------------------------------------------

def _sf_call(messages: list[dict], temperature: float = 0.1) -> dict | None:
    """Call SiliconFlow's OpenAI-compatible API."""
    payload = {
        "model": SF_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 8192,
        "response_format": {"type": "json_object"},
    }

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        SF_BASE,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SILICONFLOW_KEY}",
        },
        method="POST",
    )

    for attempt in range(MAX_RETRIES):
        try:
            resp = urllib.request.urlopen(req, timeout=180, context=_SSL_CONTEXT)
            data = json.loads(resp.read().decode("utf-8"))
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            if not content.strip():
                return None
            return {"raw_text": content}
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            if e.code == 429 or e.code >= 500:
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                print(f"    [SiliconFlow] {e.code}, retry in {delay}s... ({body_text[:80]})")
                time.sleep(delay)
                continue
            print(f"    [SiliconFlow] HTTP {e.code}: {body_text}")
            return None
        except Exception as e:
            delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
            print(f"    [SiliconFlow] error: {e}, retry in {delay}s...")
            time.sleep(delay)
            # Rebuild the request (urlopen consumes it)
            req = urllib.request.Request(
                SF_BASE, data=body,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {SILICONFLOW_KEY}"},
                method="POST",
            )

    print(f"    [SiliconFlow] failed after {MAX_RETRIES} retries")
    return None


# ---------------------------------------------------------------------------
# Backend 2: Gemini (native API)
# ---------------------------------------------------------------------------

def _gemini_call(payload: dict) -> dict | None:
    """Call Gemini's native generateContent API."""
    url = f"{GEMINI_API_BASE}/models/{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    for attempt in range(MAX_RETRIES):
        try:
            resp = urllib.request.urlopen(req, timeout=180, context=_SSL_CONTEXT)
            data = json.loads(resp.read().decode("utf-8"))
            candidates = data.get("candidates", [])
            if not candidates:
                return None
            text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
            if not text.strip():
                return None
            return {"raw_text": text}
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            if e.code == 429 or e.code >= 500:
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                print(f"    [Gemini] {e.code}, retry in {delay}s... ({body_text[:80]})")
                time.sleep(delay)
                continue
            print(f"    [Gemini] HTTP {e.code}: {body_text}")
            return None
        except Exception as e:
            delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
            print(f"    [Gemini] error: {e}, retry in {delay}s...")
            time.sleep(delay)
            req = urllib.request.Request(
                url, data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

    return None


# ---------------------------------------------------------------------------
# Unified API
# ---------------------------------------------------------------------------

def _encode_images(image_paths: list[Path]) -> list[dict]:
    """Encode page images for the active backend."""
    if BACKEND == "siliconflow":
        # OpenAI format: {type: image_url, image_url: {url: data:image/png;base64,...}}
        parts = []
        for img_path in image_paths:
            with open(img_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{b64}"},
            })
        return parts
    else:
        # Gemini format: {inline_data: {mime_type, data}}
        parts = []
        for img_path in image_paths:
            with open(img_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            parts.append({
                "inline_data": {"mime_type": "image/png", "data": b64},
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
    Send page images to the vision model and return parsed JSON.

    Returns:
        Parsed JSON dict, or None on failure.
    """
    if not BACKEND:
        raise RuntimeError("No vision API key set. Set SILICONFLOW_API_KEY or GEMINI_API_KEY.")

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

    image_parts = _encode_images(page_images)

    # ---- Build request per backend ----
    if BACKEND == "siliconflow":
        # OpenAI-compatible: images go in the user message content array
        content = [{"type": "text", "text": user_prompt}] + image_parts
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ]
        raw = _sf_call(messages, temperature=0.1)
    else:
        # Gemini native
        content_parts = [{"text": user_prompt}] + image_parts
        payload = {
            "contents": [{"role": "user", "parts": content_parts}],
            "systemInstruction": {"parts": [{"text": system}]},
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": 8192,
                "responseMimeType": "application/json",
            },
        }
        raw = _gemini_call(payload)

    if not raw:
        return None

    # Parse the JSON response
    text = raw["raw_text"].strip()
    # Strip markdown fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
    text = text.replace("```json", "").replace("```", "").strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to salvage by extracting the JSON object
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
        print(f"    [{BACKEND}] JSON parse failed. First 200 chars: {text[:200]}")
        return None


def test_connection() -> bool:
    """Quick connectivity test."""
    if not BACKEND:
        print("No vision API key set. Set one of:")
        print("  export SILICONFLOW_API_KEY=sk-xxx   # China-accessible, WeChat/Alipay")
        print("  export GEMINI_API_KEY=xxx           # requires VPN")
        return False

    if BACKEND == "siliconflow":
        try:
            # Simple text-only call to verify the key works
            payload = {
                "model": SF_MODEL,
                "messages": [{"role": "user", "content": "Say OK"}],
                "max_tokens": 5,
            }
            body = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(SF_BASE, data=body, headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {SILICONFLOW_KEY}",
            }, method="POST")
            resp = urllib.request.urlopen(req, timeout=15, context=_SSL_CONTEXT)
            data = json.loads(resp.read().decode("utf-8"))
            print(f"SiliconFlow OK. Model: {SF_MODEL}")
            return True
        except Exception as e:
            print(f"SiliconFlow unreachable: {e}")
            return False
    else:
        try:
            url = f"{GEMINI_API_BASE}/models?key={GEMINI_KEY}"
            req = urllib.request.Request(url)
            resp = urllib.request.urlopen(req, timeout=15, context=_SSL_CONTEXT)
            data = json.loads(resp.read().decode("utf-8"))
            print(f"Gemini OK. Model: {GEMINI_MODEL}")
            return True
        except Exception as e:
            print(f"Gemini unreachable: {e}")
            return False
