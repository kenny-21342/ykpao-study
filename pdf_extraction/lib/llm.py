"""
DeepSeek API wrapper with strict JSON schema + LaTeX delimiter rules.

Fixes vs. old code:
  - Prompts now mandate $...$ math and escaped \\$ currency
  - Response parsed defensively (repair_json fallback)
  - No recursion-based retry (uses a loop to avoid stack growth)
  - API key from env only
"""
import json
import re
import time
import requests
from json_repair import repair_json
from typing import Optional, Dict, List

from .config import (
    API_KEY, API_URL, MODEL, MAX_TOKENS, TEMPERATURE,
    REQUEST_TIMEOUT, MAX_RETRIES, RETRY_DELAY,
)
from .latex import normalize_latex

QP_SYSTEM = (
    "Extract exam questions. Return ONLY valid JSON. "
    "ALL mathematical notation MUST be wrapped in $...$ (inline) or $$...$$ (display). "
    "Escape literal dollar/currency signs as \\$ so they are not confused with math. "
    "Prefer \\frac{a}{b} over a/b inside math. "
    'If the page is a cover/instruction page with no real questions, return {"questions": []}. '
    "Do NOT fabricate questions."
)

QP_USER_TMPL = """Extract ALL questions from this exam paper text.

{text}

Return JSON with this EXACT shape:
{{"questions": [
  {{ "number": "1a", "text": "full question text with $math$", "marks": 3, "latex": "$x^2$", "has_diagram": false }}
]}}

Rules:
- number: the question label as printed (e.g. "1", "2a", "3(b)(ii)")
- text: the FULL verbatim question text, with all math in $...$
- latex: the key formula in $...$ if present, else ""
- marks: integer
- has_diagram: true if the question references a diagram/figure/graph/table
- Do NOT truncate or summarize
- Return COMPLETE valid JSON only
"""

MS_SYSTEM = (
    "Extract mark-scheme entries. Return ONLY valid JSON. "
    "ALL math in $...$. Escape currency as \\$. "
    'If the text is generic marking principles or a cover page, return {"questions": []}. '
    "Do NOT fabricate."
)

MS_USER_TMPL = """Extract ALL mark-scheme entries from this text.

{text}

Return JSON with this EXACT shape:
{{"questions": [
  {{ "number": "1(a)", "marking_points": ["point 1", "point 2"], "marks": 2, "answer": "brief answer" }}
]}}

Rules:
- Root key MUST be "questions"
- Include ALL marking points verbatim
- Return valid JSON only
"""


def _clean_markdown(raw: str) -> str:
    """Strip ``` fences and JS-style comments."""
    raw = raw.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    raw = raw.replace("```json", "").replace("```", "").strip()
    raw = re.sub(r"//.*?$", "", raw, flags=re.MULTILINE)
    return raw


def _normalize_shape(parsed):
    """Coerce API output to a dict with a 'questions' list."""
    if isinstance(parsed, list):
        return {"questions": parsed}
    if isinstance(parsed, dict):
        if "questions" in parsed:
            return parsed
        for alt in ("mark_schemes", "results", "data"):
            if alt in parsed:
                return {"questions": parsed[alt]}
    return None


def _parse_response(content: str):
    """Try json.loads → repair_json → None."""
    content = _clean_markdown(content)
    try:
        return _normalize_shape(json.loads(content))
    except json.JSONDecodeError:
        try:
            return _normalize_shape(repair_json(content))
        except Exception:
            return None


def call_deepseek(
    text: str,
    doc_type: str,
) -> Optional[Dict]:
    """
    Call DeepSeek, return {questions: [...], _truncated: bool}.
    Raises if API_KEY missing. Retries 429/5xx with backoff (loop, not recursion).
    """
    if not API_KEY:
        raise RuntimeError(
            "DEEPSEEK_API_KEY is not set. Export it before running extraction."
        )

    is_ms = doc_type == "ms"
    system = MS_SYSTEM if is_ms else QP_SYSTEM
    user = (MS_USER_TMPL if is_ms else QP_USER_TMPL).format(text=text)

    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }

    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.post(
                API_URL, headers=headers, json=payload, timeout=REQUEST_TIMEOUT
            )
        except requests.exceptions.Timeout:
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY * 2)
                continue
            return None
        except Exception as e:
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY)
                continue
            print(f"[REQUEST ERROR] {e}")
            return None

        if resp.status_code == 200:
            data = resp.json()
            choices = data.get("choices") or []
            if not choices:
                return None
            finish = choices[0].get("finish_reason")
            content = choices[0]["message"]["content"].strip()
            parsed = _parse_response(content)
            if parsed is None:
                parsed = {"questions": []}
            parsed["_truncated"] = finish == "length"
            return parsed

        # Retryable
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt < MAX_RETRIES:
                delay = RETRY_DELAY * (attempt + 1) if resp.status_code == 429 else RETRY_DELAY
                time.sleep(delay)
                continue
        print(f"[API {resp.status_code}] {resp.text[:200]}")
        return None

    return None


def normalize_questions(questions: List[Dict], doc_type: str) -> List[Dict]:
    """
    Post-process extracted questions:
      - normalize LaTeX in text/answer/mark marking_points
      - coerce types
    """
    out = []
    for q in questions:
        if not isinstance(q, dict):
            continue
        item = {
            "number": str(q.get("number", "")).strip(),
            "marks": int(q.get("marks") or 0),
            "has_diagram": bool(q.get("has_diagram", False)),
        }
        if doc_type == "qp":
            item["text"] = normalize_latex(str(q.get("text", "")))
            item["latex"] = normalize_latex(str(q.get("latex", "")))
        else:
            item["answer"] = normalize_latex(str(q.get("answer", "")))
            mp = q.get("marking_points", [])
            item["marking_points"] = [normalize_latex(str(p)) for p in mp] if isinstance(mp, list) else []
        out.append(item)
    return out
