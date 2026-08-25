from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
from typing import Any, Iterable

from .models import DETECTOR_VERSION
from .pipeline import load_question_papers


PILOT_VERSION = "QuestionImagePilotV1"
DEFAULT_TARGET = 100
DEFAULT_EDGE_CASES = 16
EDGE_CASE_QUOTAS = {
    "caie_9709_q1_q3": 3,
    "diagram_heavy_science": 3,
    "multiple_choice": 3,
    "essay_layout": 3,
    "multilingual_layout": 2,
    "scanned_2018_ib_economics": 2,
}


def select_pilot(
    source_manifests: Iterable[Path],
    *,
    target: int = DEFAULT_TARGET,
    edge_case_slots: int = DEFAULT_EDGE_CASES,
) -> dict[str, Any]:
    paths = [path.resolve() for path in source_manifests]
    documents = load_question_papers(paths)
    by_subject: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for document in documents:
        metadata = document["metadata"]
        by_subject[(str(metadata.get("board")), str(metadata.get("subject_id")))].append(document)
    for values in by_subject.values():
        values.sort(key=_document_sort_key)

    selected: dict[str, tuple[dict[str, Any], list[str]]] = {}
    base_limit = max(0, target - edge_case_slots)
    for subject in sorted(by_subject):
        for document in _spread(by_subject[subject], 2):
            if len(selected) >= base_limit:
                break
            selected[str(document["id"])] = (document, ["subject_coverage"])
        if len(selected) >= base_limit:
            break

    edge_added = 0
    quota_total = sum(EDGE_CASE_QUOTAS.values())
    scaled_quotas = {
        tag: (quota * edge_case_slots) // quota_total
        for tag, quota in EDGE_CASE_QUOTAS.items()
    }
    remainder = edge_case_slots - sum(scaled_quotas.values())
    for tag in EDGE_CASE_QUOTAS:
        if remainder <= 0:
            break
        scaled_quotas[tag] += 1
        remainder -= 1
    for tag, quota in scaled_quotas.items():
        candidates = sorted(
            (document for document in documents if tag in _edge_tags(document)),
            key=lambda item: _edge_sort_key(item, tag),
        )
        added_for_tag = 0
        for document in candidates:
            document_id = str(document["id"])
            if document_id in selected:
                continue
            selected[document_id] = (document, _edge_tags(document))
            edge_added += 1
            added_for_tag += 1
            if added_for_tag >= quota or edge_added >= edge_case_slots or len(selected) >= target:
                break
        if edge_added >= edge_case_slots or len(selected) >= target:
            break

    if edge_added < edge_case_slots:
        edge_candidates = sorted(
            (document for document in documents if _edge_tags(document)),
            key=lambda item: (-len(_edge_tags(item)), _document_sort_key(item)),
        )
        for document in edge_candidates:
            document_id = str(document["id"])
            if document_id in selected:
                continue
            selected[document_id] = (document, _edge_tags(document))
            edge_added += 1
            if edge_added >= edge_case_slots or len(selected) >= target:
                break

    if len(selected) < target:
        for document in sorted(documents, key=_document_sort_key):
            document_id = str(document["id"])
            if document_id not in selected:
                selected[document_id] = (document, ["reallocated_subject_shortfall"])
            if len(selected) >= target:
                break
    if len(selected) > target:
        raise ValueError("Pilot selection exceeded its target")

    entries = []
    for document_id, (document, reasons) in sorted(
        selected.items(), key=lambda item: _document_sort_key(item[1][0]),
    ):
        metadata = document["metadata"]
        entries.append({
            "documentId": document_id,
            "paperPath": document["local_path"],
            "sha256": document.get("sha256"),
            "board": metadata.get("board"),
            "subjectId": metadata.get("subject_id"),
            "subjectName": metadata.get("subject_name"),
            "year": metadata.get("year"),
            "session": metadata.get("session"),
            "paperNumber": metadata.get("paper_number"),
            "reasons": sorted(set(reasons)),
        })
    represented = {(entry["board"], entry["subjectId"]) for entry in entries}
    return {
        "version": PILOT_VERSION,
        "detectorVersion": DETECTOR_VERSION,
        "sourceManifests": [str(path) for path in paths],
        "target": target,
        "selectedCount": len(entries),
        "representedSubjects": len(represented),
        "manualSignoffRequired": True,
        "gates": {
            "acceptedBoundaryPrecision": 1.0,
            "rootDetectionRecall": 0.98,
            "acceptedRootCoverage": 0.95,
            "requiredMaterialRetention": 1.0,
            "deterministicArtifacts": True,
            "minimumFreeBytes": 2 * 1024**3,
        },
        "documents": entries,
    }


def save_pilot(value: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def pilot_document_ids(path: Path) -> set[str]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("version") != PILOT_VERSION:
        raise ValueError(f"Unsupported pilot manifest: {value.get('version')}")
    return {str(item["documentId"]) for item in value.get("documents", [])}


def validate_signoff(path: Path) -> None:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("version") != "QuestionImagePilotSignoffV1":
        raise ValueError("Full corpus run requires QuestionImagePilotSignoffV1")
    if value.get("detectorVersion") != DETECTOR_VERSION:
        raise ValueError("Pilot sign-off detector version does not match this pipeline")
    if value.get("approved") is not True:
        raise ValueError("Pilot sign-off is not approved")
    gates = value.get("gates", {})
    required = {
        "acceptedBoundaryPrecision": 1.0,
        "rootDetectionRecall": 0.98,
        "acceptedRootCoverage": 0.95,
        "requiredMaterialRetention": 1.0,
        "deterministicArtifacts": True,
        "diskProjectionFits": True,
    }
    for key, threshold in required.items():
        actual = gates.get(key)
        if isinstance(threshold, bool):
            if actual is not threshold:
                raise ValueError(f"Pilot gate failed: {key}")
        elif not isinstance(actual, (int, float)) or actual < threshold:
            raise ValueError(f"Pilot gate failed: {key}={actual!r}, required {threshold}")


def _edge_tags(document: dict[str, Any]) -> list[str]:
    metadata = document["metadata"]
    subject = str(metadata.get("subject_name", "")).lower()
    subject_id = str(metadata.get("subject_id", "")).lower()
    path = str(document.get("local_path", "")).lower()
    paper = str(metadata.get("paper_number", ""))
    tags: list[str] = []
    if subject_id == "9709":
        tags.append("caie_9709_q1_q3")
    if any(term in subject for term in ("biology", "chemistry", "physics", "design", "geography")):
        tags.append("diagram_heavy_science")
    if paper in {"1", "2"} and metadata.get("board") == "CAIE" and subject_id in {"0610", "0620", "0625"}:
        tags.append("multiple_choice")
    if any(term in subject for term in ("literature", "history", "philosophy", "psychology", "global politics")):
        tags.append("essay_layout")
    if metadata.get("board") == "IB" and (metadata.get("language", "en") != "en" or any(
        token in f"{path} {subject}"
        for token in ("_es", "_fr", "spanish", "french", "chinese", "german", "portuguese")
    )):
        tags.append("multilingual_layout")
    if "2018 examination session" in path and "economics" in subject:
        tags.append("scanned_2018_ib_economics")
    return tags


def _spread(documents: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    if len(documents) <= count:
        return list(documents)
    if count == 1:
        return [documents[0]]
    return [documents[round(index * (len(documents) - 1) / (count - 1))] for index in range(count)]


def _document_sort_key(document: dict[str, Any]) -> tuple[Any, ...]:
    metadata = document["metadata"]
    return (
        str(metadata.get("board", "")),
        str(metadata.get("subject_id", "")),
        int(metadata.get("year", 0)),
        str(metadata.get("session", "")),
        str(metadata.get("paper_number", "")),
        str(document.get("id", "")),
    )


def _edge_sort_key(document: dict[str, Any], tag: str) -> tuple[Any, ...]:
    if tag == "scanned_2018_ib_economics":
        text_characters = int(document.get("validation", {}).get("text_character_count", 10**9))
        return (text_characters, *_document_sort_key(document))
    return _document_sort_key(document)
