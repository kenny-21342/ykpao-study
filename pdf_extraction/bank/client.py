"""OpenAI-compatible JSON client for the v4 pipeline.

v4 originally reused ``pdf_extraction.v3.openai_compatible``. That client is
not neutral transport: ``_validate_job_response`` requires every reply to carry
v3's ``questions``/``markSchemes`` document shape and raises
"extraction response was empty" otherwise. A v4 flat-contract reply therefore
failed validation on every attempt, retried, and died — stage 3 could never
have produced a single row.

This module keeps the parts of the v3 client that were genuinely good (retry
with exponential backoff, key redaction, artifact logging, fenced-JSON
recovery) and drops the contract coupling. Callers supply their own validator.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError

import requests
from requests.adapters import HTTPAdapter

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_TIMEOUT_SECONDS = 300

# How long to wait when the provider rate-limits us without saying for how long,
# and the ceiling on any wait it does ask for.
RATE_LIMIT_BACKOFF_SECONDS = 20.0
MAX_RATE_LIMIT_WAIT = 90.0

_SUPPORTED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


class ProviderError(RuntimeError):
    """A provider call that could not be turned into usable JSON."""

    def __init__(self, message: str, *, raw_response: Any = None) -> None:
        super().__init__(message)
        self.raw_response = raw_response


class Unpayable(ProviderError):
    """The account cannot pay for the call.

    Separated from every other 4xx because retrying is pointless and continuing
    is worse: a corpus run that meets an empty balance would otherwise spend
    three attempts per question across tens of thousands of questions, turning
    a stopped run into hours of guaranteed failures. Callers should abandon the
    run rather than skip the question.
    """


class RateLimited(ProviderError):
    """The provider asked us to slow down.

    Carries the server's requested delay so the caller waits that long rather
    than the usual 1-2s exponential step, which is far too short for a quota
    window and just burns attempts.
    """

    def __init__(self, message: str, retry_after: float, *, raw_response: Any = None) -> None:
        super().__init__(message, raw_response=raw_response)
        self.retry_after = retry_after


@dataclass(frozen=True)
class CallResult:
    """One successful provider call."""

    content: dict[str, Any]
    model: str | None
    response_id: str | None
    attempts: int
    input_tokens: int
    output_tokens: int
    errors: tuple[dict[str, Any], ...] = ()

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


def call_json(
    *,
    endpoint: str,
    api_key: str,
    model: str,
    system_prompt: str,
    user_text: str,
    image_paths: list[Path] | None = None,
    validator: Callable[[dict[str, Any]], None] | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    temperature: float = 0.0,
    max_tokens: int | None = None,
    image_detail: str = "high",
    sleep: Callable[[float], None] = time.sleep,
    artifact_dir: Path | None = None,
) -> CallResult:
    """Call an OpenAI-compatible chat endpoint and return parsed JSON.

    ``validator`` receives the decoded object and should raise to trigger a
    retry. Passing ``None`` accepts any JSON object.
    """
    if not api_key.strip():
        raise ValueError("api_key is required")
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")

    content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    for image_path in image_paths or []:
        content.append({
            "type": "image_url",
            "image_url": {"url": _image_data_url(image_path), "detail": image_detail},
        })

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    if max_tokens is not None:
        # Bound generation. A mark scheme with many marking points can otherwise
        # run long enough to exceed the read timeout and be retried forever.
        body["max_tokens"] = max_tokens

    diagnostics: list[dict[str, Any]] = []
    last_error: Exception | None = None

    for attempt in range(1, max_attempts + 1):
        try:
            response = _post_json(endpoint, api_key, body, timeout_seconds)
            _write_artifact(artifact_dir, attempt, "response", response, api_key)
            parsed = _parse_assistant_json(response)
            if validator is not None:
                validator(parsed)
            usage = response.get("usage") or {}
            return CallResult(
                content=parsed,
                model=_optional_string(response.get("model")),
                response_id=_optional_string(response.get("id")),
                attempts=attempt,
                input_tokens=int(usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0),
                output_tokens=int(usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0),
                errors=tuple(diagnostics),
            )
        except Unpayable:
            raise
        except (HTTPError, URLError, TimeoutError, OSError, ValueError,
                requests.RequestException, ProviderError) as error:
            last_error = error
            diagnostic = {
                "attempt": attempt,
                "errorType": type(error).__name__,
                "message": _redact(str(error), api_key),
            }
            diagnostics.append(diagnostic)
            _write_artifact(artifact_dir, attempt, "error", diagnostic, api_key)
            if attempt < max_attempts:
                if isinstance(error, RateLimited):
                    sleep(min(error.retry_after, MAX_RATE_LIMIT_WAIT))
                else:
                    sleep(float(2 ** (attempt - 1)))

    raise ProviderError(
        f"no valid response after {max_attempts} attempts: "
        f"{_redact(str(last_error), api_key)}"
    ) from last_error


_SESSIONS = threading.local()


def _session() -> requests.Session:
    """A connection-pooling session, one per thread.

    Every call used to go through urlopen, which opens a fresh socket each
    time: a DNS lookup and a full TLS handshake per request. Across a subject
    that is thousands of handshakes bought for nothing, and it is also what
    made the pipeline fragile under load -- with an unrelated upload job
    saturating the link, resolution started failing outright
    ("nodename nor servname provided") and every attempt burned its 30s
    timeout. A pooled connection is reused, so the handshake is paid once per
    thread and the name is resolved once.

    Sessions are thread-local because requests.Session is not documented as
    thread-safe, and the transcription pool calls this from several workers at
    once. The underlying urllib3 pool is per-session, so each worker keeps its
    own warm connection.
    """
    session = getattr(_SESSIONS, "session", None)
    if session is None:
        session = requests.Session()
        # Retries are handled by call_json, which also validates the body and
        # knows about Retry-After. A second retry layer here would multiply
        # the wait and hide the diagnostics.
        adapter = HTTPAdapter(pool_connections=4, pool_maxsize=8, max_retries=0)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        _SESSIONS.session = session
    return session


def _post_json(
    endpoint: str,
    api_key: str,
    body: dict[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    payload = json.dumps(body, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "smart-edu-v4-bank/1.0",
    }
    try:
        response = _session().post(
            endpoint, data=payload, headers=headers,
            timeout=timeout_seconds, verify=_ca_bundle(),
        )
    except requests.RequestException as error:
        # A pooled connection can be closed by the far end between calls; the
        # caller retries, which re-opens it.
        raise ProviderError(f"request failed: {error}") from error

    if response.status_code >= 400:
        detail = response.text[:65536]
        if response.status_code == 429:
            raise RateLimited(
                f"HTTP 429: {detail[:300]}",
                _retry_after(response.headers, default=RATE_LIMIT_BACKOFF_SECONDS),
                raw_response={"httpStatus": 429, "body": detail},
            )
        # 402 is the provider's "out of credit". 401/403 are a bad or revoked
        # key. None of the three can come good on a second attempt.
        if response.status_code in (401, 402, 403):
            raise Unpayable(
                f"HTTP {response.status_code}: {detail[:300]}",
                raw_response={"httpStatus": response.status_code, "body": detail},
            )
        raise ProviderError(
            f"HTTP {response.status_code}: {detail[:600]}",
            raw_response={"httpStatus": response.status_code, "body": detail},
        )

    raw = response.content
    try:
        payload_json = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ProviderError(
            "provider response was not JSON",
            raw_response={"body": raw.decode("utf-8", errors="replace")[:2000]},
        ) from error

    if not isinstance(payload_json, dict):
        raise ProviderError("provider response was not a JSON object",
                            raw_response=payload_json)
    if payload_json.get("error"):
        raise ProviderError(f"provider error: {payload_json['error']}",
                            raw_response=payload_json)
    return payload_json


def _retry_after(headers: Any, *, default: float) -> float:
    """Seconds the server asked us to wait, or ``default`` if it did not say."""
    try:
        raw = (headers.get("Retry-After") or "").strip()
    except Exception:
        raw = ""
    if raw:
        try:
            return max(1.0, float(raw))
        except ValueError:
            # The header may be an HTTP date rather than a count of seconds.
            pass
    return default


def _ca_bundle() -> Any:
    """certifi's bundle when it is installed, otherwise the system default."""
    try:
        import certifi
    except ImportError:
        return True
    return certifi.where()


def _parse_assistant_json(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ProviderError("provider response has no choices", raw_response=response)

    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None

    # Say so when the reply was cut off. Otherwise truncation arrives as a JSON
    # parse error, and the diagnostic blames the model for malformed output
    # instead of naming the ceiling that produced it.
    if choices[0].get("finish_reason") == "length":
        raise ProviderError(
            "response truncated at max_tokens (finish_reason=length)",
            raw_response={"truncated": True},
        )

    # Some providers return content as a list of typed parts.
    if isinstance(content, list):
        content = "".join(
            str(part.get("text", ""))
            for part in content
            if isinstance(part, dict) and part.get("type") in {"text", "output_text"}
        )

    if not isinstance(content, str) or not content.strip():
        raise ProviderError("assistant content was empty", raw_response=response)

    cleaned = content.strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", cleaned, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        cleaned = fence.group(1)

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        parsed = _repair_json(cleaned)

    if not isinstance(parsed, dict):
        raise ProviderError("assistant content was not a JSON object", raw_response=cleaned[:2000])
    return parsed


def _repair_json(text: str) -> Any:
    """Last-ditch recovery for almost-valid JSON."""
    try:
        import json_repair
    except ImportError:
        pass
    else:
        try:
            return json_repair.loads(text)
        except Exception:
            pass
    # Fall back to the outermost brace pair.
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError as error:
            raise ProviderError("assistant content was not valid JSON") from error
    raise ProviderError("assistant content was not valid JSON")


def _image_data_url(path: Path) -> str:
    path = Path(path)
    if not path.is_file():
        raise ValueError(f"image does not exist: {path}")
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if mime_type not in _SUPPORTED_IMAGE_TYPES:
        raise ValueError(f"unsupported image type {mime_type} for {path}")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _redact(message: str, api_key: str) -> str:
    text = message.replace("\n", " ")
    if api_key:
        text = text.replace(api_key, "[REDACTED]")
    text = re.sub(r"(?i)(bearer )[^\s,}\"]+", r"\1[REDACTED]", text)
    return text[:1000]


def _write_artifact(
    artifact_dir: Path | None,
    attempt: int,
    kind: str,
    value: Any,
    api_key: str,
) -> None:
    if artifact_dir is None:
        return
    artifact_dir.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True, default=str) + "\n"
    if api_key:
        encoded = encoded.replace(api_key, "[REDACTED]")
    (artifact_dir / f"attempt-{attempt:02d}-{kind}.json").write_text(encoded, encoding="utf-8")
