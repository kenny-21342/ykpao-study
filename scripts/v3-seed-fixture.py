"""Create and publish a small synthetic V3 corpus for local development."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys

import fitz

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pdf_extraction.v3.metadata import parse_caie_filename
from pdf_extraction.v3.model import ModelSpec
from pdf_extraction.v3.models import CorpusManifest, ManifestDocument
from pdf_extraction.v3.pdf import validate_pdf
from pdf_extraction.v3.pipeline import PipelineConfig, _normalize_extraction, run_document_pipeline


SOURCE_ROOT = ROOT / "data/v3/sources"
MANIFEST_PATH = ROOT / "data/v3/manifests/synthetic-gold.json"
FIXTURE_ROOT = ROOT / "data/v3/work/fixture-inputs"


def main() -> None:
    SOURCE_ROOT.mkdir(parents=True, exist_ok=True)
    FIXTURE_ROOT.mkdir(parents=True, exist_ok=True)
    qp_path = SOURCE_ROOT / "9709_s23_qp_12.pdf"
    ms_path = SOURCE_ROOT / "9709_s23_ms_12.pdf"
    make_question_pdf(qp_path)
    make_mark_scheme_pdf(ms_path)
    qp = ManifestDocument(parse_caie_filename(qp_path.name), source_paths=[str(qp_path)], local_path=str(qp_path), status="ready")
    ms = ManifestDocument(parse_caie_filename(ms_path.name), source_paths=[str(ms_path)], local_path=str(ms_path), status="ready")
    manifest = CorpusManifest("synthetic-gold", "authoritative", {qp.id: qp, ms.id: ms})
    manifest.save(MANIFEST_PATH)

    qp_extraction = question_extraction(qp.id)
    normalized = _normalize_extraction(deepcopy(qp_extraction), qp, validate_pdf(qp_path).sha256)
    equation_id = next(block["id"] for block in normalized["questions"][0]["blocks"] if block["type"] == "math")
    qp_extract_path = write_fixture("qp-extractor.json", qp_extraction)
    qp_verify_path = write_fixture("qp-verifier.json", {
        "accepted": True,
        "confidence": 0.998,
        "equationChecks": [{"blockId": equation_id, "accepted": True, "note": "Synthetic gold visual match"}],
        "issues": [],
        "usage": {"inputTokens": 100, "outputTokens": 20, "estimatedCostUsd": 0.25},
    })
    run_document_pipeline(manifest, MANIFEST_PATH, qp.id, config(qp_extract_path, qp_verify_path))

    ms_extract_path = write_fixture("ms-extractor.json", mark_scheme_extraction(ms.id))
    ms_verify_path = write_fixture("ms-verifier.json", {
        "accepted": True,
        "confidence": 0.997,
        "equationChecks": [],
        "issues": [],
        "usage": {"inputTokens": 60, "outputTokens": 18, "estimatedCostUsd": 0.14},
    })
    run_document_pipeline(manifest, MANIFEST_PATH, ms.id, config(ms_extract_path, ms_verify_path))
    print(json.dumps({"manifest": str(MANIFEST_PATH), "questionDocumentId": qp.id, "markSchemeDocumentId": ms.id}, indent=2))


def config(extractor: Path, verifier: Path) -> PipelineConfig:
    return PipelineConfig(
        work_root=ROOT / "data/v3/work",
        asset_root=ROOT / "data/v3/assets",
        extractor=ModelSpec("fixture-primary", "synthetic-vision-primary", f"fixture:{extractor}"),
        verifier=ModelSpec("fixture-independent", "synthetic-vision-verifier", f"fixture:{verifier}"),
        publish=True,
    )


def write_fixture(name: str, payload: dict) -> Path:
    path = FIXTURE_ROOT / name
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def make_question_pdf(path: Path) -> None:
    document = fitz.open()
    first = document.new_page(width=595, height=842)
    first.insert_text((45, 36), "Cambridge International Examination")
    first.insert_text((45, 95), "1 The curve has equation y = x^2 + 1.")
    first.insert_text((45, 125), "Find its stationary point.")
    second = document.new_page(width=595, height=842)
    second.insert_text((45, 36), "Cambridge International Examination")
    second.insert_text((45, 90), "Question 1 continued")
    second.insert_text((45, 125), "(a) State the coordinates and complete the table.")
    shape = second.new_shape()
    shape.draw_rect(fitz.Rect(80, 175, 320, 325))
    shape.draw_line(fitz.Point(80, 250), fitz.Point(320, 250))
    shape.draw_line(fitz.Point(200, 175), fitz.Point(200, 325))
    shape.finish(width=2)
    shape.commit()
    document.save(path)
    document.close()


def make_mark_scheme_pdf(path: Path) -> None:
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((45, 45), "MARK SCHEME")
    page.insert_text((45, 100), "1 (a) (0, 1) M1 A1 [2]")
    document.save(path)
    document.close()


def provenance(document_id: str, page: int, bbox: list[int]) -> list[dict]:
    return [{"sourceDocumentId": document_id, "page": page, "bbox": {"x0": bbox[0], "y0": bbox[1], "x1": bbox[2], "y1": bbox[3]}, "nativeBlockIds": []}]


def paragraph(block_id: str, text: str, document_id: str, page: int, bbox: list[int]) -> dict:
    return {"id": block_id, "type": "paragraph", "order": 0, "provenance": provenance(document_id, page, bbox), "content": {"segments": [{"type": "text", "text": text}]}}


def question_extraction(document_id: str) -> dict:
    return {
        "questions": [{
            "rootNumber": "1", "marks": 2,
            "blocks": [
                paragraph("p1", "The curve has equation", document_id, 1, [45, 85, 360, 112]),
                {"id": "m1", "type": "math", "order": 1, "provenance": provenance(document_id, 1, [45, 90, 330, 125]), "content": {"latex": "y=x^2+1", "displayMode": "display"}},
                {"id": "s1", "type": "subpart", "order": 2, "provenance": provenance(document_id, 2, [45, 112, 340, 330]), "content": {
                    "label": "(a)", "path": ["a"], "marks": 2,
                    "blocks": [
                        paragraph("p2", "State the coordinates and complete the table.", document_id, 2, [45, 112, 420, 145]),
                        {"id": "f1", "type": "figure", "order": 1, "provenance": provenance(document_id, 2, [80, 175, 320, 325]), "content": {"clientAssetId": "figure-1", "role": "diagram", "caption": "Coordinate grid", "displayOrder": 0}},
                        {"id": "t1", "type": "table", "order": 2, "provenance": provenance(document_id, 2, [80, 175, 320, 250]), "content": {
                            "caption": "Coordinates", "columnCount": 2, "confidence": 0.99, "fallbackClientAssetId": "table-1",
                            "rows": [{"id": "row1", "cells": [
                                {"id": "c1", "header": True, "rowSpan": 1, "colSpan": 1, "content": [paragraph("cp1", "x", document_id, 2, [80, 175, 200, 250])]},
                                {"id": "c2", "header": True, "rowSpan": 1, "colSpan": 1, "content": [paragraph("cp2", "y", document_id, 2, [200, 175, 320, 250])]},
                            ]}],
                        }},
                    ],
                }},
            ],
        }],
        "markSchemes": [],
        "assets": [
            {"clientId": "figure-1", "page": 2, "bbox": [80, 175, 320, 325], "role": "diagram", "material": "diagram", "caption": "Coordinate grid"},
            {"clientId": "table-1", "page": 2, "bbox": [80, 175, 320, 250], "role": "table_fallback", "material": "diagram", "qaOnly": True},
        ],
        "topicAssignments": {"1": [{"code": "9709-3.2", "canonicalLabel": "Differentiation", "taxonomyVersion": "9709-2023", "source": "official-syllabus", "confidence": 0.99, "effectiveFromYear": 2023}]},
        "tagAssignments": {"1": [{"canonicalLabel": "stationary-points", "aliases": ["stationary point"], "taxonomyVersion": "v1", "source": "extractor", "confidence": 0.99}]},
        "usage": {"inputTokens": 100, "outputTokens": 50, "estimatedCostUsd": 0.5},
    }


def mark_scheme_extraction(document_id: str) -> dict:
    return {
        "questions": [], "assets": [],
        "markSchemes": [{
            "rootNumber": "1", "marks": 2,
            "sections": [{"id": "raw-section", "order": 0, "path": ["a"], "label": "(a)", "points": [{
                "id": "raw-point", "order": 0, "markCode": "M1 A1", "marks": 2,
                "answer": [{"type": "text", "text": "Coordinates (0, 1)"}],
                "alternatives": [], "acceptableAnswers": [], "notes": [[{"type": "text", "text": "Award both marks for the correct ordered pair."}]],
                "provenance": provenance(document_id, 1, [45, 85, 350, 125]),
            }]}],
        }],
        "usage": {"inputTokens": 60, "outputTokens": 30, "estimatedCostUsd": 0.2},
    }


if __name__ == "__main__":
    main()
