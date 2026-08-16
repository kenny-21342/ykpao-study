#!/usr/bin/env python3
from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import asdict
import json
import os
from pathlib import Path
import shutil
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Load .env from the project root so V3_OPENAI_* keys are available.
_env_file = ROOT / ".env"
if _env_file.exists():
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _key, _, _val = _line.partition("=")
        _key = _key.strip()
        _val = _val.strip().strip('"').strip("'")
        if _key and _key not in os.environ:
            os.environ[_key] = _val

from pdf_extraction.v3.model import ModelSpec
from pdf_extraction.v3.models import CorpusManifest
from pdf_extraction.v3.pipeline import PipelineConfig, PipelineResult, run_document_pipeline


SILICONFLOW_ENDPOINT = "https://api.siliconflow.cn/v1/chat/completions"
QWEN_MODEL = "Qwen/Qwen3-VL-32B-Instruct"
CHECKPOINT_INTERVAL = 100
SUPPORTED_DOCUMENT_TYPES = {"question_paper", "mark_scheme"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a resumable, review-only V3 extraction corpus batch.")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--work-root", type=Path)
    parser.add_argument("--asset-root", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--keep-page-renders", action="store_true")
    parser.add_argument("--min-free-gib", type=float, default=2.0)
    args = parser.parse_args(argv)

    api_key = os.environ.get("V3_OPENAI_API_KEY", "")
    if not api_key.strip():
        print(
            "V3_OPENAI_API_KEY is missing from this process environment; no provider calls were made",
            file=sys.stderr,
        )
        return 2
    endpoint = os.environ.get("V3_OPENAI_CHAT_COMPLETIONS_URL", SILICONFLOW_ENDPOINT).rstrip("/")
    model = os.environ.get("V3_OPENAI_MODEL", QWEN_MODEL)
    if endpoint != SILICONFLOW_ENDPOINT or model != QWEN_MODEL:
        print(
            f"This batch requires endpoint {SILICONFLOW_ENDPOINT} and model {QWEN_MODEL}",
            file=sys.stderr,
        )
        return 2
    try:
        configured_attempts = int(os.environ.get("V3_OPENAI_MAX_ATTEMPTS", "3"))
    except ValueError:
        print("V3_OPENAI_MAX_ATTEMPTS must be an integer", file=sys.stderr)
        return 2
    if configured_attempts < 1:
        print("V3_OPENAI_MAX_ATTEMPTS must be at least 1", file=sys.stderr)
        return 2
    os.environ["V3_OPENAI_CHAT_COMPLETIONS_URL"] = endpoint
    os.environ["V3_OPENAI_MODEL"] = model
    os.environ["V3_OPENAI_MAX_ATTEMPTS"] = str(configured_attempts)

    manifest_path = args.manifest.resolve()
    if not manifest_path.is_file():
        print(f"Manifest does not exist: {manifest_path}", file=sys.stderr)
        return 2
    manifest = CorpusManifest.load(manifest_path)
    batch_name = manifest_path.stem
    work_root = (args.work_root or ROOT / "data/v3/work/batches" / batch_name).resolve()
    asset_root = (args.asset_root or ROOT / "data/v3/assets/batches" / batch_name).resolve()
    state_root = work_root / "batch-state"
    state_root.mkdir(parents=True, exist_ok=True)
    asset_root.mkdir(parents=True, exist_ok=True)
    ledger_path = state_root / "ledger.jsonl"
    progress_path = state_root / "progress.json"
    _replay_ledger(manifest, ledger_path)

    eligible_statuses = {"ready", "extracting"}
    if args.retry_failed:
        eligible_statuses.add("failed")
    candidates = [
        document_id for document_id, document in sorted(manifest.documents.items())
        if document.status in eligible_statuses and document.metadata.document_type in SUPPORTED_DOCUMENT_TYPES
    ]
    if args.limit is not None:
        if args.limit < 1:
            print("--limit must be at least 1", file=sys.stderr)
            return 2
        candidates = candidates[:args.limit]

    counts = {
        "eligible": len(candidates),
        "processed": 0,
        "review": 0,
        "failed": 0,
        "skipped": len(manifest.documents) - len(candidates),
        "unsupportedResources": sum(
            document.metadata.document_type not in SUPPORTED_DOCUMENT_TYPES
            for document in manifest.documents.values()
        ),
    }
    _write_json(progress_path, _progress_payload(manifest, counts, "running", model, endpoint))
    extractor = ModelSpec(
        "siliconflow",
        model,
        f"{sys.executable} scripts/v3-openai-compatible-adapter.py",
    )
    minimum_free = int(args.min_free_gib * 1024 ** 3)
    exit_code = 0
    batch_status = "complete"

    try:
        for document_id in candidates:
            free_bytes = shutil.disk_usage(work_root).free
            if free_bytes < minimum_free:
                batch_status = "stopped-low-disk"
                exit_code = 3
                break
            document = deepcopy(manifest.documents[document_id])
            if document.status == "extracting":
                document.transition("ready")
            single_manifest = CorpusManifest(
                corpus_id=manifest.corpus_id,
                catalog_basis=manifest.catalog_basis,
                documents={document_id: document},
            )
            document_manifest_path = state_root / "documents" / f"{document_id}.json"
            single_manifest.save(document_manifest_path)
            try:
                result = run_document_pipeline(
                    single_manifest,
                    document_manifest_path,
                    document_id,
                    PipelineConfig(
                        work_root=work_root,
                        asset_root=asset_root,
                        extractor=extractor,
                        publish=True,
                    ),
                )
                if document.status not in {"review", "published"}:
                    document.status = "review"
                record = _ledger_record(document_id, document, result=result)
                counts["review"] += 1
            except Exception as error:
                record = _ledger_record(document_id, document, error=error)
                counts["failed"] += 1
            finally:
                if not args.keep_page_renders:
                    _prune_rendered_pages(work_root)
            manifest.documents[document_id] = document
            _append_ledger(ledger_path, record)
            counts["processed"] += 1
            if counts["processed"] % CHECKPOINT_INTERVAL == 0:
                manifest.save(manifest_path)
            _write_json(progress_path, _progress_payload(manifest, counts, "running", model, endpoint))
    except KeyboardInterrupt:
        batch_status = "interrupted"
        exit_code = 130
    finally:
        manifest.save(manifest_path)
        _write_json(progress_path, _progress_payload(manifest, counts, batch_status, model, endpoint))

    print(json.dumps({
        "status": batch_status,
        "manifest": str(manifest_path),
        "workRoot": str(work_root),
        "assetRoot": str(asset_root),
        "progress": str(progress_path),
        "counts": counts,
        "published": False,
    }, sort_keys=True))
    return exit_code


def _replay_ledger(manifest: CorpusManifest, ledger_path: Path) -> None:
    if not ledger_path.is_file():
        return
    for line in ledger_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        document = manifest.documents.get(str(record.get("documentId", "")))
        if not document:
            continue
        document.status = record["status"]
        document.last_error = record.get("lastError")


def _ledger_record(
    document_id: str,
    document: Any,
    *,
    result: PipelineResult | None = None,
    error: Exception | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "documentId": document_id,
        "status": document.status,
        "lastError": document.last_error,
        "published": False,
    }
    if result:
        payload["result"] = asdict(result)
    if error:
        payload["error"] = _safe_error(error)
    return payload


def _append_ledger(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as ledger:
        ledger.write(json.dumps(record, sort_keys=True, ensure_ascii=True) + "\n")
        ledger.flush()
        os.fsync(ledger.fileno())


def _safe_error(error: Exception) -> str:
    message = str(error).replace("\n", " ")[:4000]
    api_key = os.environ.get("V3_OPENAI_API_KEY", "")
    return message.replace(api_key, "[REDACTED]") if api_key else message


def _prune_rendered_pages(work_root: Path) -> None:
    for page_dir in work_root.glob("v3r_*/pages"):
        if page_dir.is_dir():
            shutil.rmtree(page_dir)


def _progress_payload(
    manifest: CorpusManifest,
    counts: dict[str, int],
    status: str,
    model: str,
    endpoint: str,
) -> dict[str, Any]:
    statuses: dict[str, int] = {}
    for document in manifest.documents.values():
        statuses[document.status] = statuses.get(document.status, 0) + 1
    return {
        "version": "V3CorpusBatchProgressV1",
        "status": status,
        "corpusId": manifest.corpus_id,
        "requestedModel": model,
        "endpoint": endpoint,
        "counts": counts,
        "manifestStatuses": dict(sorted(statuses.items())),
        "published": False,
        "databaseAccessed": False,
    }


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


if __name__ == "__main__":
    raise SystemExit(main())
