#!/usr/bin/env python3
from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import asdict
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pdf_extraction.v3.assets import materialize_assets
from pdf_extraction.v3.metadata import parse_caie_filename
from pdf_extraction.v3.model import ModelSpec, extraction_job, verification_job
from pdf_extraction.v3.models import ManifestDocument, stable_id
from pdf_extraction.v3.openai_compatible import ProviderResponseError, ProviderResult, run_json_job
from pdf_extraction.v3.pdf import preflight_pdf
from pdf_extraction.v3.pipeline import PipelineConfig, _build_bundle, _normalize_extraction, _quality_gates


SILICONFLOW_ENDPOINT = "https://api.siliconflow.cn/v1/chat/completions"
QWEN_MODEL = "Qwen/Qwen3-VL-32B-Instruct"

def _siliconflow_api_key() -> str:
    """
    The project's one SiliconFlow key, under either of the two names it has.

    These scripts have always read V3_OPENAI_API_KEY — a generic name for what
    is pinned below to api.siliconflow.cn and Qwen3-VL. The web app and
    pdf_extraction/lib/vision_client.py read SILICONFLOW_API_KEY, which is the
    canonical name. Accept both so one key in the environment serves the whole
    project; V3_OPENAI_API_KEY still wins where both are set.
    """
    return os.environ.get("V3_OPENAI_API_KEY") or os.environ.get("SILICONFLOW_API_KEY", "")

SOURCE_PDF = ROOT / "pdf_extraction/my_raw_pdfs/a-level/mathematics-9709/9709_s23_qp_12.pdf"
EXACT_TRANSCRIPTIONS = {
    "1": (
        "1 The equation of a curve is such that dy/dx = 4/(x-3)^3 for x > 3. "
        "The curve passes through the point (4, 5). Find the equation of the curve. [3]"
    ),
    "2": (
        "2 The coefficient of x^4 in the expansion of (x + a)^6 is p and the coefficient of x^2 "
        "in the expansion of (ax + 3)^4 is q. It is given that p + q = 276. "
        "Find the possible values of the constant a. [4]"
    ),
    "3": (
        "3 (a) Express 4x^2 - 24x + p in the form a(x + b)^2 + c, where a and b are integers "
        "and c is to be given in terms of the constant p. [2] "
        "(b) Hence or otherwise find the set of values of p for which the equation "
        "4x^2 - 24x + p = 0 has no real roots. [1]"
    ),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run an isolated Qwen3-VL SiliconFlow probe and CAIE 9709 Q1-Q3 extraction test.",
    )
    parser.add_argument("--source-pdf", type=Path, default=SOURCE_PDF)
    parser.add_argument("--work-dir", type=Path)
    args = parser.parse_args(argv)

    api_key = _siliconflow_api_key()
    if not api_key.strip():
        print(
            "V3_OPENAI_API_KEY (or SILICONFLOW_API_KEY) is required and must be "
            "supplied only in the process environment",
            file=sys.stderr,
        )
        return 2
    endpoint = os.environ.get("V3_OPENAI_CHAT_COMPLETIONS_URL", SILICONFLOW_ENDPOINT).rstrip("/")
    model = os.environ.get("V3_OPENAI_MODEL", QWEN_MODEL)
    if endpoint != SILICONFLOW_ENDPOINT:
        print(f"This test requires V3_OPENAI_CHAT_COMPLETIONS_URL={SILICONFLOW_ENDPOINT}", file=sys.stderr)
        return 2
    if model != QWEN_MODEL:
        print(f"This test requires V3_OPENAI_MODEL={QWEN_MODEL}", file=sys.stderr)
        return 2
    try:
        configured_attempts = int(os.environ.get("V3_OPENAI_MAX_ATTEMPTS", "3"))
        timeout_seconds = int(os.environ.get("V3_OPENAI_TIMEOUT_SECONDS", "180"))
    except ValueError:
        print("V3_OPENAI_MAX_ATTEMPTS and V3_OPENAI_TIMEOUT_SECONDS must be integers", file=sys.stderr)
        return 2
    max_attempts = min(3, configured_attempts)
    if max_attempts < 1:
        print("V3_OPENAI_MAX_ATTEMPTS must be at least 1", file=sys.stderr)
        return 2

    source_pdf = args.source_pdf.resolve()
    if not source_pdf.is_file():
        print(f"Source PDF does not exist: {source_pdf}", file=sys.stderr)
        return 2
    try:
        work_dir = _create_work_dir(args.work_dir)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    database_before = _database_state()
    report: dict[str, Any] = {
        "version": "V3SiliconFlowQwen3VLTestReportV1",
        "status": "RUNNING",
        "stage": "preflight",
        "workDir": str(work_dir),
        "sourcePdf": str(source_pdf),
        "provider": "siliconflow",
        "requestedModel": model,
        "endpoint": endpoint,
        "maxAttempts": max_attempts,
        "publishRequested": False,
        "databaseAccessed": False,
    }
    report_path = work_dir / "run-report.json"
    _write_json(report_path, report)

    try:
        metadata = parse_caie_filename(source_pdf.name)
        source = ManifestDocument(
            metadata,
            source_paths=[str(source_pdf)],
            local_path=str(source_pdf),
            status="review",
        )
        preflight = preflight_pdf(source_pdf, work_dir / "source", source.id, metadata.document_type)
        validation = preflight["validation"]
        source.sha256 = validation["sha256"]
        source.byte_size = validation["byte_size"]
        source.page_count = validation["page_count"]
        source.readable = validation["readable"]
        source.validation = validation
        pages = {int(page["page"]): page for page in preflight["pages"]}
        selected_pages = [pages[number] for number in (2, 3, 4)]

        report["stage"] = "probe"
        _write_json(report_path, report)
        probe_job = {
            "task": "probe-image-transcription",
            "imagePath": pages[2]["renderPath"],
            "instructions": (
                "Transcribe question 1 exactly in plain linear text, including every word, displayed "
                "mathematical expression, domain, point, punctuation, and the bracketed mark allocation. "
                "Do not solve the question."
            ),
            "responseContract": {
                "readable": "boolean",
                "transcription": "exact plain-text string including [3]",
                "marks": "integer",
            },
            "localValidation": {"exactTranscription": EXACT_TRANSCRIPTIONS["1"]},
        }
        _write_json(work_dir / "probe" / "job.json", probe_job)
        probe = run_json_job(
            probe_job,
            endpoint=endpoint,
            api_key=api_key,
            model=model,
            max_attempts=max_attempts,
            timeout_seconds=timeout_seconds,
            artifact_dir=work_dir / "probe" / "provider-attempts",
        )
        _write_json(work_dir / "probe" / "parsed-response.json", _provider_payload(probe))
        report["probe"] = _provider_summary(probe)
        report["probe"]["accepted"] = True

        report["stage"] = "structured-extraction"
        _write_json(report_path, report)
        limited_preflight = deepcopy(preflight)
        limited_preflight["pages"] = selected_pages
        structured_job = extraction_job(metadata.to_dict(), limited_preflight)
        structured_job["requirements"]["scope"] = (
            "Extract exactly roots 1, 2, and 3 from the three supplied source pages; exclude response lines, "
            "page numbers, copyright text, and turn-over furniture."
        )
        structured_job["requirements"]["sourceTranscriptions"] = (
            "Return an exact plain linear transcription for each root, including subpart labels and marks."
        )
        structured_job["responseContract"]["sourceTranscriptions"] = {
            "1": "exact plain transcription including [3]",
            "2": "exact plain transcription including [4]",
            "3": "exact plain transcription including (a) [2] and (b) [1]",
        }
        structured_job["localValidation"] = {
            "expectedRootNumbers": ["1", "2", "3"],
            "expectedMarks": {"1": 3, "2": 4, "3": 3},
            "expectedRootPages": {"1": 2, "2": 3, "3": 4},
            "expectedSubpartMarks": {"3": {"a": 2, "b": 1}},
            "exactSourceTranscriptions": EXACT_TRANSCRIPTIONS,
            "requiredQaSourceCrops": {"qa-q1": 2, "qa-q2": 3, "qa-q3": 4},
        }
        _write_json(work_dir / "extraction" / "job.json", structured_job)
        extracted = run_json_job(
            structured_job,
            endpoint=endpoint,
            api_key=api_key,
            model=model,
            max_attempts=max_attempts,
            timeout_seconds=timeout_seconds,
            artifact_dir=work_dir / "extraction" / "provider-attempts",
        )
        _write_json(work_dir / "extraction" / "parsed-response.json", _provider_payload(extracted))
        report["extraction"] = _provider_summary(extracted)

        extraction = deepcopy(extracted.content)
        extraction["usage"] = extracted.usage
        extraction["providerResponse"] = _provider_summary(extracted)
        normalized = _normalize_extraction(extraction, source, validation["sha256"])
        asset_root = work_dir / "assets"
        assets = materialize_assets(normalized, limited_preflight, asset_root, source.id)
        _write_json(work_dir / "extraction" / "normalized-response.json", normalized)

        report["stage"] = "review-and-quality-gates"
        _write_json(report_path, report)
        review_job = verification_job(metadata.to_dict(), limited_preflight, normalized)
        review_path = work_dir / "review" / "job.json"
        _write_json(review_path, review_job)
        completed = subprocess.run(
            [sys.executable, "scripts/v3-review-only-verifier.py", str(review_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode or not completed.stdout.strip():
            raise RuntimeError(completed.stderr.strip() or "review-only verifier returned no response")
        verification = json.loads(completed.stdout)
        _write_json(work_dir / "review" / "response.json", verification)
        issues = _quality_gates(normalized, verification, asset_root, work_dir / "quality")

        run_id = stable_id("v3test", {
            "sourceHash": validation["sha256"],
            "model": model,
            "responseId": extracted.response_id,
        })
        config = PipelineConfig(
            work_root=work_dir,
            asset_root=asset_root,
            extractor=ModelSpec("siliconflow", model, "in-process-openai-compatible-v3-adapter"),
            verifier=ModelSpec("independent-verifier-unavailable", "review-only", "review-only"),
            publish=False,
        )
        bundle = _build_bundle(
            source,
            run_id,
            validation["sha256"],
            config,
            normalized,
            verification,
            assets,
            issues,
        )
        if bundle["run"]["status"] != "REVIEW" or any(
            question["publicationStatus"] != "REVIEW" for question in bundle["questions"]
        ):
            raise RuntimeError("review-only test unexpectedly produced an approvable bundle")
        bundle_path = work_dir / "review-bundle.json"
        _write_json(bundle_path, bundle)

        unexpected_gate_issues = [
            asdict(issue) for issue in issues
            if issue.issue_type not in {"independent_verification_unavailable", "verification", "formula_verification"}
        ]
        issue_types = {issue.issue_type for issue in issues}
        gate_results = {
            "schema": "schema" not in issue_types,
            "katex": "latex" not in issue_types,
            "numbering": "numbering_continuity" not in issue_types,
            "marks": "mark_total" not in issue_types,
            "whitespace": "whitespace" not in issue_types,
            "assets": not issue_types.intersection({"asset_missing", "table_structure"}),
            "provenance": "provenance" not in issue_types,
            "sourceAccuracy": True,
            "independentFormulaVerification": "formula_verification" not in issue_types,
        }
        structured_gates_passed = all(
            passed for gate, passed in gate_results.items() if gate != "independentFormulaVerification"
        )
        report.update({
            "status": "REVIEW",
            "stage": "complete",
            "published": False,
            "databaseAccessed": False,
            "source": {
                "sha256": validation["sha256"],
                "renderDpi": preflight["renderDpi"],
                "pagesSubmitted": [2, 3, 4],
            },
            "counts": {
                "questions": len(normalized["questions"]),
                "assets": len(assets),
                "issues": len(issues),
                "unexpectedGateIssues": len(unexpected_gate_issues),
            },
            "gateResults": gate_results,
            "structuredGatesPassed": structured_gates_passed and not unexpected_gate_issues,
            "publicationGatesPassed": False,
            "issues": [asdict(issue) for issue in issues],
            "artifacts": {
                "bundle": str(bundle_path),
                "preflight": str(work_dir / "source" / "preflight.json"),
                "probeAttempts": str(work_dir / "probe" / "provider-attempts"),
                "extractionAttempts": str(work_dir / "extraction" / "provider-attempts"),
            },
        })
        exit_code = 0 if report["structuredGatesPassed"] else 1
    except Exception as error:
        diagnostics = list(error.diagnostics) if isinstance(error, ProviderResponseError) else []
        report.update({
            "status": "FAILED",
            "failureStage": report.get("stage"),
            "failureMessage": _sanitized_error(error, api_key),
            "diagnostics": diagnostics,
            "published": False,
            "databaseAccessed": False,
        })
        exit_code = 1

    database_after = _database_state()
    report["databaseFilesUnchanged"] = database_before == database_after
    _write_json(report_path, report)
    print(json.dumps({
        "status": report["status"],
        "stage": report.get("stage"),
        "workDir": str(work_dir),
        "report": str(report_path),
        "structuredGatesPassed": report.get("structuredGatesPassed"),
        "publicationGatesPassed": report.get("publicationGatesPassed"),
        "databaseFilesUnchanged": report["databaseFilesUnchanged"],
    }, sort_keys=True))
    return exit_code


def _create_work_dir(requested: Path | None) -> Path:
    temp_root = Path(tempfile.gettempdir()).resolve()
    if requested is None:
        path = Path(tempfile.mkdtemp(prefix="smart-edu-siliconflow-qwen3-vl-"))
        path.chmod(0o700)
        return path
    path = requested.resolve()
    if not path.is_relative_to(temp_root):
        raise ValueError(f"--work-dir must be under the temporary directory {temp_root}")
    if path.exists() and any(path.iterdir()):
        raise ValueError(f"--work-dir must be empty: {path}")
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def _provider_summary(result: ProviderResult) -> dict[str, Any]:
    return {
        "requestedModel": result.requested_model,
        "returnedModel": result.returned_model,
        "responseId": result.response_id,
        "attempts": result.attempts,
        "usage": result.usage,
        "errors": list(result.errors),
    }


def _provider_payload(result: ProviderResult) -> dict[str, Any]:
    return {"content": result.content, "providerResponse": _provider_summary(result)}


def _database_state() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name in ("papers.db", "papers.db-shm", "papers.db-wal"):
        path = ROOT / name
        if path.exists():
            stat = path.stat()
            result[name] = {"size": stat.st_size, "mtimeNs": stat.st_mtime_ns}
    return result


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n", encoding="utf-8")


def _sanitized_error(error: Exception, api_key: str) -> str:
    message = str(error).replace("\n", " ")[:4000]
    return message.replace(api_key, "[REDACTED]") if api_key else message


if __name__ == "__main__":
    raise SystemExit(main())
