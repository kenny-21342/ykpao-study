from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import time
from typing import Any, Iterable

from .detector import detect_roots
from .evidence import extract_document_evidence, file_sha256
from .models import (
    CorpusManifest,
    DETECTOR_VERSION,
    QuestionImageRecord,
    SourceRegion,
    stable_id,
    summarize,
)
from .regions import RootRegions, build_source_regions
from .renderer import choose_render_dpi, render_accepted_asset, render_review_preview


DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024**3


class LowDiskSpaceError(RuntimeError):
    pass


@dataclass(frozen=True)
class PipelineConfig:
    output_root: Path
    minimum_free_bytes: int = DEFAULT_MINIMUM_FREE_BYTES
    tesseract: str = "tesseract"
    temp_root: Path | None = None
    keep_previews: bool = True


@dataclass(frozen=True)
class BatchResult:
    status: str
    manifest_path: str
    ledger_path: str
    report_path: str
    processed_documents: int
    resumed_documents: int
    eligible_documents: int
    records: int
    accepted: int
    quarantined: int


def process_document(document: dict[str, Any], config: PipelineConfig) -> list[QuestionImageRecord]:
    _guard_disk(config.output_root, config.minimum_free_bytes)
    metadata = dict(document.get("metadata", {}))
    if metadata.get("document_type") != "question_paper":
        raise ValueError("Question image extraction accepts question papers only")
    source_path = Path(str(document.get("local_path") or ""))
    if not source_path.is_file():
        raise FileNotFoundError(f"Question paper does not exist: {source_path}")
    document_id = str(document.get("id") or stable_id("qidoc", str(source_path)))
    paper_id = _paper_id(document)
    language = str(metadata.get("language", "en"))
    evidence = extract_document_evidence(
        source_path,
        language=language,
        tesseract=config.tesseract,
        temp_root=config.temp_root,
    )
    detection = detect_roots(evidence)
    if not detection.roots:
        record = _document_quarantine_record(
            document,
            paper_id,
            document_id,
            evidence.source_sha256,
            list(detection.diagnostics) or [{"reason": "no_roots_detected"}],
        )
        return [record]

    root_regions = build_source_regions(evidence, detection)
    records: list[QuestionImageRecord] = []
    for item in root_regions:
        _guard_disk(config.output_root, config.minimum_free_bytes)
        records.append(_materialize_root(
            document,
            paper_id,
            document_id,
            evidence.source_sha256,
            evidence.native_text_characters,
            evidence.used_ocr,
            source_path,
            item,
            config,
        ))
    return records


def run_batch(
    source_manifest_paths: Iterable[Path],
    config: PipelineConfig,
    *,
    selected_document_ids: set[str] | None = None,
    limit: int | None = None,
) -> BatchResult:
    started = time.monotonic()
    source_paths = [path.resolve() for path in source_manifest_paths]
    all_documents = load_question_papers(source_paths)
    source_question_papers = len(all_documents)
    documents = all_documents
    if selected_document_ids is not None:
        documents = [item for item in documents if str(item.get("id")) in selected_document_ids]
    if limit is not None:
        if limit < 1:
            raise ValueError("limit must be at least 1")
        documents = documents[:limit]

    output_root = config.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    state_root = output_root / "state"
    state_root.mkdir(parents=True, exist_ok=True)
    ledger_path = state_root / "ledger.jsonl"
    manifest_path = output_root / "QuestionImageCorpusV1.json"
    report_path = output_root / "run-report.json"
    completed, record_map = replay_ledger(ledger_path)
    processed = 0
    resumed = 0
    status = "COMPLETE"
    errors: list[dict[str, str]] = []

    for document in documents:
        document_id = str(document.get("id", ""))
        expected_hash = str(document.get("sha256") or "")
        completion = completed.get(document_id)
        if completion and completion.get("detectorVersion") == DETECTOR_VERSION and (
            not expected_hash or completion.get("sourceSha256") == expected_hash
        ):
            resumed += 1
            continue
        try:
            _guard_disk(output_root, config.minimum_free_bytes)
            records = process_document(document, config)
        except LowDiskSpaceError:
            status = "STOPPED_LOW_DISK"
            break
        except Exception as error:
            source_path = Path(str(document.get("local_path") or ""))
            source_hash = expected_hash
            if not source_hash and source_path.is_file():
                source_hash = file_sha256(source_path)
            records = [_document_quarantine_record(
                document,
                _paper_id(document),
                document_id or stable_id("qidoc", str(source_path)),
                source_hash,
                [{"reason": "document_processing_error", "detail": _safe_error(error)}],
            )]
            errors.append({"documentId": document_id, "error": _safe_error(error)})

        ledger_record = {
            "version": "QuestionImageLedgerEntryV1",
            "documentId": document_id,
            "sourceSha256": records[0].source_sha256 if records else expected_hash,
            "detectorVersion": DETECTOR_VERSION,
            "records": [record.to_dict() for record in records],
        }
        _append_ledger(ledger_path, ledger_record)
        previous = completed.get(document_id)
        if previous:
            for value in previous.get("records", []):
                record_map.pop(str(value.get("id", "")), None)
        completed[document_id] = ledger_record
        for record in records:
            record_map[record.id] = record
        processed += 1

    corpus = CorpusManifest(
        records=list(record_map.values()),
        source_manifests=[str(path) for path in source_paths],
    )
    corpus.save(manifest_path)
    summary = summarize(corpus.records)
    elapsed = round(time.monotonic() - started, 3)
    artifact_document_count = len({record.document_id for record in corpus.records})
    average_asset_bytes_per_paper = summary["assetBytes"] / max(1, artifact_document_count)
    projected_asset_bytes = int(average_asset_bytes_per_paper * source_question_papers)
    free_at_finish = shutil.disk_usage(output_root).free
    projected_additional_bytes = max(0, projected_asset_bytes - summary["assetBytes"])
    disk_projection_fits = free_at_finish - projected_additional_bytes >= config.minimum_free_bytes
    accepted_coverage = summary["accepted"] / max(1, summary["records"])
    deterministic_artifacts = _determinism_proven(
        output_root / "determinism-report.json",
        manifest_path,
        summary["records"],
    )
    manual_review_pending = [
        "acceptedBoundaryPrecision",
        "rootDetectionRecall",
        "requiredMaterialRetention",
    ]
    if not deterministic_artifacts:
        manual_review_pending.append("independentDeterminismRun")
    report = {
        "version": "QuestionImageRunReportV1",
        "status": status,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "detectorVersion": DETECTOR_VERSION,
        "sourceManifests": [str(path) for path in source_paths],
        "eligibleDocuments": len(documents),
        "sourceQuestionPapers": source_question_papers,
        "artifactDocuments": artifact_document_count,
        "processedDocuments": processed,
        "resumedDocuments": resumed,
        "elapsedSeconds": elapsed,
        "minimumFreeBytes": config.minimum_free_bytes,
        "freeBytesAtFinish": free_at_finish,
        "projectedAssetBytes": projected_asset_bytes,
        "projectedAdditionalAssetBytes": projected_additional_bytes,
        "diskProjectionFits": disk_projection_fits,
        "pilotGates": {
            "acceptedRootCoverage": round(accepted_coverage, 6),
            "acceptedRootCoverageRequired": 0.95,
            "acceptedRootCoveragePassed": accepted_coverage >= 0.95,
            "diskProjectionFits": disk_projection_fits,
            "deterministicArtifacts": deterministic_artifacts,
            "manualReviewPending": manual_review_pending,
            "signoffReady": False,
        },
        "summary": summary,
        "errors": errors,
        "published": False,
    }
    _write_json(report_path, report)
    return BatchResult(
        status=status,
        manifest_path=str(manifest_path),
        ledger_path=str(ledger_path),
        report_path=str(report_path),
        processed_documents=processed,
        resumed_documents=resumed,
        eligible_documents=len(documents),
        records=summary["records"],
        accepted=summary["accepted"],
        quarantined=summary["quarantined"],
    )


def load_question_papers(source_manifest_paths: Iterable[Path]) -> list[dict[str, Any]]:
    documents: dict[str, dict[str, Any]] = {}
    for path in source_manifest_paths:
        value = json.loads(path.read_text(encoding="utf-8"))
        for document in value.get("documents", []):
            metadata = document.get("metadata", {})
            if metadata.get("document_type") != "question_paper" or not document.get("local_path"):
                continue
            document_id = str(document.get("id", ""))
            if not document_id:
                continue
            documents[document_id] = document
    return [documents[key] for key in sorted(documents)]


def replay_ledger(
    ledger_path: Path,
) -> tuple[dict[str, dict[str, Any]], dict[str, QuestionImageRecord]]:
    completed: dict[str, dict[str, Any]] = {}
    records: dict[str, QuestionImageRecord] = {}
    if not ledger_path.is_file():
        return completed, records
    for line in ledger_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        document_id = str(entry.get("documentId", ""))
        if not document_id:
            continue
        previous = completed.get(document_id)
        if previous:
            for value in previous.get("records", []):
                records.pop(str(value.get("id", "")), None)
        completed[document_id] = entry
        for value in entry.get("records", []):
            record = QuestionImageRecord.from_dict(value)
            records[record.id] = record
    return completed, records


def _materialize_root(
    document: dict[str, Any],
    paper_id: str,
    document_id: str,
    source_hash: str,
    native_characters: int,
    used_ocr: bool,
    source_path: Path,
    item: RootRegions,
    config: PipelineConfig,
) -> QuestionImageRecord:
    metadata = document.get("metadata", {})
    candidate = item.root.candidate
    record_id = stable_id("qir", {
        "documentId": document_id,
        "sourceSha256": source_hash,
        "sectionIndex": candidate.section_index,
        "section": candidate.section,
        "rootNumber": candidate.number,
        "candidatePage": candidate.page,
        "candidateBbox": list(candidate.bbox),
        "candidateLineId": candidate.line_id,
        "detectorVersion": DETECTOR_VERSION,
    })
    diagnostics = [*item.root.diagnostics, *item.diagnostics]
    regions = list(item.regions)
    confidence: dict[str, Any] = {
        "candidateScore": candidate.score,
        "candidateSignals": list(candidate.signals),
        "sequenceMargin": item.root.sequence_margin,
        "nativeTextCharacters": native_characters,
        "usedOcr": used_ocr,
        "rootSource": candidate.source,
        "essentialVisuals": item.essential_visuals,
        "markAllocations": item.mark_allocations,
        "responseLinesRemoved": item.response_lines_removed,
    }
    image: dict[str, Any] | None = None
    preview_path: str | None = None
    status = "QUARANTINED" if diagnostics else "ACCEPTED"

    if status == "ACCEPTED":
        rendered = render_accepted_asset(source_path, regions, config.output_root)
        confidence["renderAnalysis"] = rendered.analysis or {}
        if rendered.accepted:
            regions = [replace(region, source_dpi=rendered.dpi) for region in regions]
            image = {
                "width": rendered.width,
                "height": rendered.height,
                "dpi": rendered.dpi,
                "mode": rendered.mode,
                "sha256": rendered.image_sha256,
                "path": rendered.image_path,
                "bytes": rendered.byte_size,
                "separatorPixels": 24,
            }
        else:
            status = "QUARANTINED"
            diagnostics.extend(rendered.diagnostics)
    else:
        selected_dpi = choose_render_dpi(regions)
        if selected_dpi:
            regions = [replace(region, source_dpi=selected_dpi) for region in regions]

    if status == "QUARANTINED" and config.keep_previews:
        preview_path = render_review_preview(
            source_path,
            regions,
            config.output_root,
            document_id,
            record_id,
        )
    return QuestionImageRecord(
        id=record_id,
        paper_id=paper_id,
        document_id=document_id,
        source_path=str(source_path),
        source_sha256=source_hash,
        board=str(metadata.get("board", "UNKNOWN")),
        subject_id=str(metadata.get("subject_id", "unknown")),
        subject_name=str(metadata.get("subject_name", metadata.get("subject_id", "Unknown"))),
        root_number=str(candidate.number),
        section=candidate.section,
        source_regions=regions,
        image=image,
        detector_version=DETECTOR_VERSION,
        confidence=confidence,
        diagnostics=diagnostics,
        preview_path=preview_path,
        status=status,  # type: ignore[arg-type]
    )


def _document_quarantine_record(
    document: dict[str, Any],
    paper_id: str,
    document_id: str,
    source_hash: str,
    diagnostics: list[dict[str, Any]],
) -> QuestionImageRecord:
    metadata = document.get("metadata", {})
    record_id = stable_id("qir", {
        "documentId": document_id,
        "sourceSha256": source_hash,
        "rootNumber": "unknown",
        "detectorVersion": DETECTOR_VERSION,
    })
    return QuestionImageRecord(
        id=record_id,
        paper_id=paper_id,
        document_id=document_id,
        source_path=str(document.get("local_path") or ""),
        source_sha256=source_hash,
        board=str(metadata.get("board", "UNKNOWN")),
        subject_id=str(metadata.get("subject_id", "unknown")),
        subject_name=str(metadata.get("subject_name", metadata.get("subject_id", "Unknown"))),
        root_number="unknown",
        section="default",
        source_regions=[],
        status="QUARANTINED",
        confidence={"usedOcr": False},
        diagnostics=diagnostics,
    )


def _paper_id(document: dict[str, Any]) -> str:
    metadata = document.get("metadata", {})
    return stable_id("qip", {
        key: metadata.get(key, "")
        for key in (
            "board", "qualification", "subject_id", "level", "year", "session",
            "paper_number", "paper_type", "component", "variant", "timezone", "language",
        )
    })


def _guard_disk(path: Path, minimum_free_bytes: int) -> None:
    target = path if path.exists() else path.parent
    target.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(target).free
    if free < minimum_free_bytes:
        raise LowDiskSpaceError(
            f"Free disk space {free} is below required reserve {minimum_free_bytes}"
        )


def _append_ledger(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n"
    with path.open("a", encoding="utf-8") as ledger:
        ledger.write(encoded)
        ledger.flush()
        os.fsync(ledger.fileno())


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def _safe_error(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"[:1000]


def _determinism_proven(report_path: Path, manifest_path: Path, record_count: int) -> bool:
    if not report_path.is_file():
        return False
    try:
        value = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    manifest_sha256 = file_sha256(manifest_path)
    return (
        value.get("version") == "QuestionImageDeterminismReportV1"
        and value.get("detectorVersion") == DETECTOR_VERSION
        and value.get("deterministic") is True
        and value.get("firstRecords") == record_count
        and value.get("secondRecords") == record_count
        and value.get("firstManifestSha256") == manifest_sha256
        and value.get("secondManifestSha256") == manifest_sha256
    )
