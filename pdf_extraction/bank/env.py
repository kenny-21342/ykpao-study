"""Environment loading for the v4 pipeline.

Credentials live in the repository ``.env`` file, but nothing in the Python
pipeline reads it — ``os.environ`` is populated by Next.js at runtime, not by
a bare ``python3`` process. Every provider call therefore failed with
"environment variable is required" even though the key was sitting in ``.env``.

This module loads ``.env`` on demand without adding a dependency, and resolves
provider settings from the names the repository actually uses. Real environment
variables always win, so CI and shell exports keep overriding the file.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# Repository root, three levels up from pdf_extraction/bank/env.py.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_loaded = False


def load_dotenv(path: Path | None = None, *, override: bool = False) -> dict[str, str]:
    """Read ``.env`` into ``os.environ`` and return what was parsed.

    Values may be quoted; ``export`` prefixes and blank/comment lines are
    ignored. Existing environment variables are preserved unless ``override``.
    """
    global _loaded
    env_path = Path(path) if path else _REPO_ROOT / ".env"
    parsed: dict[str, str] = {}
    if not env_path.is_file():
        _loaded = True
        return parsed

    for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # Strip one matching pair of surrounding quotes.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if not key:
            continue
        parsed[key] = value
        if override or key not in os.environ:
            os.environ[key] = value

    _loaded = True
    return parsed


def ensure_loaded() -> None:
    """Load ``.env`` once per process."""
    if not _loaded:
        load_dotenv()


def _first_env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def vision_settings() -> dict[str, Any]:
    """Resolve the vision (Qwen3-VL via SiliconFlow) provider settings."""
    ensure_loaded()
    endpoint = _first_env(
        "V4_VISION_URL",
        "V3_OPENAI_CHAT_COMPLETIONS_URL",
        "SILICONFLOW_CHAT_COMPLETIONS_URL",
    )
    api_key = _first_env("V4_VISION_API_KEY", "V3_OPENAI_API_KEY", "SILICONFLOW_API_KEY")
    model = _first_env("V4_VISION_MODEL", "V3_OPENAI_MODEL", default="Qwen/Qwen3-VL-32B-Instruct")
    if not endpoint:
        raise ValueError(
            "No vision endpoint configured. Set V3_OPENAI_CHAT_COMPLETIONS_URL "
            "(or V4_VISION_URL) in .env or the environment."
        )
    if not api_key:
        raise ValueError(
            "No vision API key configured. Set V3_OPENAI_API_KEY "
            "(or V4_VISION_API_KEY) in .env or the environment."
        )
    return {
        "endpoint": endpoint,
        "api_key": api_key,
        "model": model,
        "max_attempts": _int_env("V3_OPENAI_MAX_ATTEMPTS", 3),
        "timeout_seconds": _int_env("V3_OPENAI_TIMEOUT_SECONDS", 300),
        # How many images one call may carry. A provider property, not a
        # corpus one: SiliconFlow accepted any number, while the Anthropic
        # route rejects more than eight outright with
        # "a request may contain at most 8 images". Raise it for a provider
        # that allows more; the corpus reaches 29 strips at its worst.
        "max_images": _int_env("V4_VISION_MAX_IMAGES", 8),
    }


def text_settings() -> dict[str, Any]:
    """Resolve the text (DeepSeek) provider settings.

    The repository stores this as ``DEEPSEEK_API_URL``; earlier v4 code looked
    for ``DEEPSEEK_CHAT_COMPLETIONS_URL``, which exists nowhere, so the tagging
    pass could never have found its endpoint.
    """
    ensure_loaded()
    endpoint = _first_env(
        "V4_TEXT_URL",
        "DEEPSEEK_API_URL",
        "DEEPSEEK_CHAT_COMPLETIONS_URL",
        default="https://api.deepseek.com/v1/chat/completions",
    )
    api_key = _first_env("V4_TEXT_API_KEY", "DEEPSEEK_API_KEY")
    model = _first_env("V4_TEXT_MODEL", "DEEPSEEK_MODEL", default="deepseek-chat")
    if not api_key:
        raise ValueError(
            "No text API key configured. Set DEEPSEEK_API_KEY in .env or the environment."
        )
    return {
        "endpoint": endpoint,
        "api_key": api_key,
        "model": model,
        "max_attempts": _int_env("DEEPSEEK_MAX_ATTEMPTS", 3),
        "timeout_seconds": _int_env("DEEPSEEK_TIMEOUT_SECONDS", 180),
    }


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default
