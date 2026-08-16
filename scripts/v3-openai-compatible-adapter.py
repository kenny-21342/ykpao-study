#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pdf_extraction.v3.openai_compatible import ProviderResponseError, run_json_job, settings_from_environment


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: scripts/v3-openai-compatible-adapter.py <job.json>", file=sys.stderr)
        return 2
    try:
        job = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        result = run_json_job(
            job,
            artifact_dir=Path(argv[1]).parent / f"{Path(argv[1]).stem}-provider-attempts",
            **settings_from_environment(),
        )
    except (OSError, ValueError, json.JSONDecodeError, ProviderResponseError) as error:
        print(str(error), file=sys.stderr)
        return 1

    payload = dict(result.content)
    payload["usage"] = result.usage
    payload["providerResponse"] = {
        "requestedModel": result.requested_model,
        "returnedModel": result.returned_model,
        "responseId": result.response_id,
        "attempts": result.attempts,
        "errors": list(result.errors),
    }
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
