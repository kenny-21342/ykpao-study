#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: scripts/v3-review-only-verifier.py <verification-job.json>", file=sys.stderr)
        return 2
    try:
        job = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 1

    questions = job.get("questions", [])
    issues = [{
        "issueType": "independent_verification_unavailable",
        "severity": "high",
        "message": "No independent vision provider was available; compare this extraction with its source crop before approval.",
        "fieldPath": f"questions[{question.get('rootNumber', index)}]",
        "evidence": {
            "rootNumber": str(question.get("rootNumber", "")),
            "sourceCropClientId": f"qa-q{question.get('rootNumber', '')}",
        },
    } for index, question in enumerate(questions)]
    print(json.dumps({
        "accepted": False,
        "confidence": 0.0,
        "equationChecks": [],
        "issues": issues,
        "usage": {"inputTokens": 0, "outputTokens": 0, "estimatedCostUsd": 0.0},
    }, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
