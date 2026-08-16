from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fitz

from pdf_extraction.v3.metadata import parse_caie_filename
from pdf_extraction.v3.model import CommandMultimodalModel, ModelSpec
from pdf_extraction.v3.models import CorpusManifest, ManifestDocument
from pdf_extraction.v3.pipeline import PipelineConfig, _normalize_extraction, run_document_pipeline
from pdf_extraction.v3.quality import validate_mark_scheme_document, validate_question_document


class PipelineTests(unittest.TestCase):
    def test_command_adapter_failure_preserves_diagnostic(self) -> None:
        with TemporaryDirectory() as temp_dir:
            model = CommandMultimodalModel(ModelSpec(
                "provider-a",
                "model-a",
                "python3 -c 'import sys; print(\"invalid provider response\", file=sys.stderr); raise SystemExit(1)'",
            ))
            with self.assertRaisesRegex(RuntimeError, "invalid provider response"):
                model.run({"task": "test"}, Path(temp_dir), "extraction")



    def test_table_and_mark_scheme_quality_gates(self) -> None:
        bad_table = {
            "version": "QuestionDocumentV1", "rootNumber": "1", "blocks": [{
                "id": "table", "type": "table", "order": 0,
                "provenance": [{"sourceDocumentId": "doc", "page": 1}],
                "content": {"columnCount": 2, "confidence": 0.8, "rows": [{"id": "r", "cells": [{"id": "c", "colSpan": 1, "content": []}]}]},
            }],
        }
        self.assertTrue(any(issue.issue_type == "table_structure" for issue in validate_question_document(bad_table)))
        bad_scheme = {"version": "MarkSchemeDocumentV1", "rootNumber": "1", "marks": 2, "sections": [{"path": [], "points": [{"marks": 1}]}]}
        self.assertTrue(any(issue.issue_type == "mark_total" for issue in validate_mark_scheme_document(bad_scheme)))

    def test_pdf_to_bundle_is_resumable_and_idempotent(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "9709_s23_qp_12.pdf"
            _make_pipeline_pdf(pdf)
            metadata = parse_caie_filename(pdf.name)
            source = ManifestDocument(metadata, source_paths=[str(pdf)], local_path=str(pdf), status="ready")
            manifest = CorpusManifest("synthetic-gold", "authoritative", {source.id: source})
            manifest_path = root / "manifest.json"
            manifest.save(manifest_path)
            extraction = _extraction_fixture(source.id)
            normalized = _normalize_extraction(deepcopy(extraction), source, "fixture-source-hash")
            equation_id = next(
                block["id"] for block in normalized["questions"][0]["blocks"] if block["type"] == "math"
            )
            extraction_path = root / "extractor.json"
            extraction_path.write_text(json.dumps(extraction), encoding="utf-8")
            config = PipelineConfig(
                work_root=root / "work",
                asset_root=root / "assets",
                extractor=ModelSpec("provider-a", "vision-a", f"fixture:{extraction_path}"),
            )


            first = run_document_pipeline(manifest, manifest_path, source.id, config)
            self.assertEqual(first.question_count, 1)
            self.assertEqual(first.issue_count, 0)
            bundle = json.loads(Path(first.bundle_path).read_text(encoding="utf-8"))
            self.assertEqual(len(bundle["questions"]), 1)
            self.assertEqual(len(bundle["assets"]), 2)
            self.assertEqual(bundle["questions"][0]["document"]["rootNumber"], "1")
            self.assertEqual(source.status, "review")

            second = run_document_pipeline(manifest, manifest_path, source.id, config)
            self.assertEqual(second.run_id, first.run_id)
            self.assertEqual(len(list((root / "assets").glob("*"))), 2)


def _make_pipeline_pdf(path: Path) -> None:
    document = fitz.open()
    first = document.new_page(width=595, height=842)
    first.insert_text((50, 50), "Question paper")
    first.insert_text((50, 110), "1 Find the stationary point of the curve.")
    first.insert_text((50, 150), "y = x^2 + 1")
    second = document.new_page(width=595, height=842)
    second.insert_text((50, 80), "Question 1 continued")
    second.insert_text((50, 120), "(a) State the coordinates and complete the table.")
    second.draw_rect(fitz.Rect(80, 170, 300, 310), width=2)
    second.draw_line(fitz.Point(80, 240), fitz.Point(300, 240), width=1)
    document.save(path)
    document.close()


def _provenance(document_id: str, page: int, bbox: list[int]) -> list[dict]:
    return [{"sourceDocumentId": document_id, "page": page, "bbox": {"x0": bbox[0], "y0": bbox[1], "x1": bbox[2], "y1": bbox[3]}, "nativeBlockIds": []}]


def _extraction_fixture(document_id: str) -> dict:
    paragraph = lambda block_id, text, page, bbox: {
        "id": block_id, "type": "paragraph", "order": 0, "provenance": _provenance(document_id, page, bbox),
        "content": {"segments": [{"type": "text", "text": text}]},
    }
    return {
        "questions": [
            {
                "rootNumber": "1", "marks": 2,
                "blocks": [
                    paragraph("raw-p", " Find the stationary point. ", 1, [40, 90, 400, 130]),
                    {"id": "raw-m", "type": "math", "order": 1, "provenance": _provenance(document_id, 1, [40, 130, 240, 160]), "content": {"latex": "y=x^2+1", "displayMode": "display"}},
                ],
            },
            {
                "rootNumber": "1", "marks": 2,
                "blocks": [{
                    "id": "raw-sub", "type": "subpart", "order": 0, "provenance": _provenance(document_id, 2, [40, 100, 420, 330]),
                    "content": {
                        "label": "(a)", "path": ["a"], "marks": 2,
                        "blocks": [
                            paragraph("raw-child", " State the coordinates. ", 2, [40, 100, 400, 130]),
                            {"id": "raw-fig", "type": "figure", "order": 1, "provenance": _provenance(document_id, 2, [80, 170, 300, 310]), "content": {"clientAssetId": "figure-1", "role": "diagram", "displayOrder": 0}},
                            {"id": "raw-table", "type": "table", "order": 2, "provenance": _provenance(document_id, 2, [80, 170, 300, 310]), "content": {
                                "columnCount": 2, "confidence": 0.99, "fallbackClientAssetId": "table-1",
                                "rows": [{"id": "row-1", "cells": [
                                    {"id": "cell-1", "header": True, "rowSpan": 1, "colSpan": 1, "content": [paragraph("cell-p1", "x", 2, [80, 170, 190, 240])]},
                                    {"id": "cell-2", "header": True, "rowSpan": 1, "colSpan": 1, "content": [paragraph("cell-p2", "y", 2, [190, 170, 300, 240])]},
                                ]}],
                            }},
                        ],
                    },
                }],
            },
        ],
        "markSchemes": [],
        "assets": [
            {"clientId": "figure-1", "page": 2, "bbox": [80, 170, 300, 310], "role": "diagram", "material": "diagram"},
            {"clientId": "table-1", "page": 2, "bbox": [80, 170, 300, 250], "role": "table_fallback", "material": "diagram", "qaOnly": True},
        ],
        "topicAssignments": {"1": [{"code": "calculus", "label": "Differentiation", "taxonomyVersion": "9709-2023", "confidence": 0.99}]},
        "tagAssignments": {"1": [{"canonicalLabel": "stationary-points", "taxonomyVersion": "v1", "confidence": 0.99}]},
        "usage": {"inputTokens": 100, "outputTokens": 50, "estimatedCostUsd": 0.5},
    }


if __name__ == "__main__":
    unittest.main()
