from __future__ import annotations

from dataclasses import asdict, dataclass, field
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Literal


DETECTOR_VERSION = "question-image-detector-v1.1.2"
MANIFEST_VERSION = "QuestionImageCorpusV1"
RECORD_VERSION = "QuestionImageRecordV1"
RecordStatus = Literal["ACCEPTED", "QUARANTINED"]


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def stable_id(prefix: str, identity: Any, length: int = 24) -> str:
    digest = sha256(canonical_json(identity).encode("utf-8")).hexdigest()[:length]
    return f"{prefix}_{digest}"


@dataclass(frozen=True)
class SourceRegion:
    order: int
    page: int
    bbox: tuple[float, float, float, float]
    source_dpi: int
    evidence: tuple[str, ...] = ()
    erase_bboxes: tuple[tuple[float, float, float, float], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["bbox"] = list(self.bbox)
        result["erase_bboxes"] = [list(item) for item in self.erase_bboxes]
        result["evidence"] = list(self.evidence)
        return result

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SourceRegion":
        return cls(
            order=int(value["order"]),
            page=int(value["page"]),
            bbox=tuple(float(item) for item in value["bbox"]),  # type: ignore[arg-type]
            source_dpi=int(value["source_dpi"]),
            evidence=tuple(str(item) for item in value.get("evidence", [])),
            erase_bboxes=tuple(
                tuple(float(number) for number in item)  # type: ignore[misc]
                for item in value.get("erase_bboxes", [])
            ),
        )


@dataclass
class QuestionImageRecord:
    id: str
    paper_id: str
    document_id: str
    source_path: str
    source_sha256: str
    board: str
    subject_id: str
    subject_name: str
    root_number: str
    section: str
    source_regions: list[SourceRegion]
    status: RecordStatus
    confidence: dict[str, Any]
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    image: dict[str, Any] | None = None
    preview_path: str | None = None
    detector_version: str = DETECTOR_VERSION
    version: str = RECORD_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "id": self.id,
            "paperId": self.paper_id,
            "documentId": self.document_id,
            "sourcePath": self.source_path,
            "sourceSha256": self.source_sha256,
            "board": self.board,
            "subjectId": self.subject_id,
            "subjectName": self.subject_name,
            "rootNumber": self.root_number,
            "section": self.section,
            "sourceRegions": [region.to_dict() for region in self.source_regions],
            "image": self.image,
            "detectorVersion": self.detector_version,
            "confidence": self.confidence,
            "diagnostics": self.diagnostics,
            "previewPath": self.preview_path,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "QuestionImageRecord":
        return cls(
            version=value.get("version", RECORD_VERSION),
            id=value["id"],
            paper_id=value["paperId"],
            document_id=value["documentId"],
            source_path=value["sourcePath"],
            source_sha256=value["sourceSha256"],
            board=value["board"],
            subject_id=value["subjectId"],
            subject_name=value.get("subjectName", value["subjectId"]),
            root_number=value["rootNumber"],
            section=value.get("section", "default"),
            source_regions=[SourceRegion.from_dict(item) for item in value.get("sourceRegions", [])],
            image=value.get("image"),
            detector_version=value.get("detectorVersion", DETECTOR_VERSION),
            confidence=dict(value.get("confidence", {})),
            diagnostics=list(value.get("diagnostics", [])),
            preview_path=value.get("previewPath"),
            status=value["status"],
        )


@dataclass
class CorpusManifest:
    records: list[QuestionImageRecord]
    source_manifests: list[str]
    corpus_id: str = "question-images-v1"
    detector_version: str = DETECTOR_VERSION
    version: str = MANIFEST_VERSION

    def to_dict(self) -> dict[str, Any]:
        records = sorted(
            self.records,
            key=lambda item: (
                item.board,
                item.subject_id,
                item.paper_id,
                item.section,
                _root_sort_key(item.root_number),
                item.id,
            ),
        )
        return {
            "version": self.version,
            "corpusId": self.corpus_id,
            "detectorVersion": self.detector_version,
            "sourceManifests": sorted(self.source_manifests),
            "records": [record.to_dict() for record in records],
            "summary": summarize(records),
        }

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".partial")
        payload = json.dumps(self.to_dict(), indent=2, sort_keys=True, ensure_ascii=True) + "\n"
        temporary.write_text(payload, encoding="utf-8")
        temporary.replace(path)

    @classmethod
    def load(cls, path: Path) -> "CorpusManifest":
        value = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            version=value.get("version", MANIFEST_VERSION),
            corpus_id=value.get("corpusId", "question-images-v1"),
            detector_version=value.get("detectorVersion", DETECTOR_VERSION),
            source_manifests=list(value.get("sourceManifests", [])),
            records=[QuestionImageRecord.from_dict(item) for item in value.get("records", [])],
        )


def summarize(records: list[QuestionImageRecord]) -> dict[str, Any]:
    by_board: dict[str, dict[str, int]] = {}
    by_subject: dict[str, dict[str, Any]] = {}
    reasons: dict[str, int] = {}
    asset_bytes_by_hash: dict[str, int] = {}
    asset_references = 0
    for record in records:
        board = by_board.setdefault(record.board, {"accepted": 0, "quarantined": 0})
        subject_key = f"{record.board}:{record.subject_id}"
        subject = by_subject.setdefault(subject_key, {
            "board": record.board,
            "subjectId": record.subject_id,
            "subjectName": record.subject_name,
            "accepted": 0,
            "quarantined": 0,
        })
        key = "accepted" if record.status == "ACCEPTED" else "quarantined"
        board[key] += 1
        subject[key] += 1
        if record.image:
            asset_references += 1
            digest = str(record.image.get("sha256") or record.image.get("path") or record.id)
            asset_bytes_by_hash.setdefault(digest, int(record.image.get("bytes", 0)))
        for diagnostic in record.diagnostics:
            reason = str(diagnostic.get("reason", "unknown"))
            reasons[reason] = reasons.get(reason, 0) + 1
    return {
        "records": len(records),
        "accepted": sum(item.status == "ACCEPTED" for item in records),
        "quarantined": sum(item.status == "QUARANTINED" for item in records),
        "assetBytes": sum(asset_bytes_by_hash.values()),
        "assetReferences": asset_references,
        "uniqueAssets": len(asset_bytes_by_hash),
        "byBoard": {key: by_board[key] for key in sorted(by_board)},
        "bySubject": {key: by_subject[key] for key in sorted(by_subject)},
        "quarantineReasons": {key: reasons[key] for key in sorted(reasons)},
    }


def _root_sort_key(value: str) -> tuple[int, str]:
    digits = "".join(character for character in value if character.isdigit())
    return (int(digits) if digits else 10**9, value)
