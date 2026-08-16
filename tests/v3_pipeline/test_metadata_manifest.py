from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from pdf_extraction.v3.gold import validate_gold_catalog
from pdf_extraction.v3.manifest import inventory_package, reconcile
from pdf_extraction.v3.metadata import parse_caie_filename, parse_document_path, parse_ib_path
from pdf_extraction.v3.models import CorpusManifest, ManifestDocument


class MetadataManifestTests(unittest.TestCase):
    def test_parses_legacy_ib_music_files(self) -> None:
        base = Path("IB PAST PAPERS - YEAR/2018 Examination Session/May 2018 Examination Session/The arts")
        listening = parse_document_path(base / "Music___listening_paper_HL.pdf", "IB")
        scheme = parse_document_path(base / "Music___HL_markscheme.pdf", "IB")
        score = parse_document_path(base / "Music___score_booklet_HLSL.pdf", "IB")
        self.assertEqual((listening.subject_name, listening.paper_number, listening.level), ("Music", "listening", "HL"))
        self.assertEqual(listening.document_type, "question_paper")
        self.assertEqual(scheme.document_type, "mark_scheme")
        self.assertEqual(score.document_type, "source_booklet")
        self.assertEqual(score.resource_code, "score-booklet")

    def test_caie_metadata_and_logical_identity(self) -> None:
        question = parse_caie_filename("9709_s23_qp_12.pdf")
        scheme = parse_caie_filename("9709_s23_ms_12.pdf")
        self.assertEqual(question.year, 2023)
        self.assertEqual(question.session, "may-june")
        self.assertEqual(question.paper_number, "1")
        self.assertEqual(question.variant, "2")
        self.assertEqual(question.paper_record_id, scheme.paper_record_id)
        self.assertNotEqual(question.document_record_id, scheme.document_record_id)

    def test_ib_metadata_preserves_timezone_level_and_inventory_semantics(self) -> None:
        path = Path("IB PAST PAPERS - YEAR/2023 Examination Session/November 2023 Examination Session/Experimental sciences/Biology_paper_2__TZ1_HL_markscheme.pdf")
        metadata = parse_ib_path(path)
        self.assertEqual(metadata.year, 2023)
        self.assertEqual(metadata.session, "november")
        self.assertEqual(metadata.level, "HL")
        self.assertEqual(metadata.timezone, "TZ1")
        self.assertEqual(metadata.document_type, "mark_scheme")

    def test_reconciliation_reports_missing_and_orphan_schemes_without_fuzzy_pairing(self) -> None:
        qp = ManifestDocument(parse_caie_filename("9709_s23_qp_12.pdf"), status="ready")
        orphan = ManifestDocument(parse_caie_filename("9709_w23_ms_13.pdf"), status="ready")
        manifest = CorpusManifest("pilot", "authoritative", {qp.id: qp, orphan.id: orphan})
        report = reconcile(manifest)
        self.assertEqual(report["missingSchemes"], [qp.id])
        self.assertEqual(report["orphanSchemes"], [orphan.id])

    def test_ib_inventory_never_claims_completeness(self) -> None:
        with TemporaryDirectory() as directory:
            manifest = inventory_package(Path(directory), "IB", "random-zip")
            report = reconcile(manifest)
            self.assertEqual(report["catalogBasis"], "package_inventory")
            self.assertIn("completeness is unknown", report["coverageClaim"])

    def test_gold_gate_rejects_unannotated_catalog(self) -> None:
        validation = validate_gold_catalog(Path("gold-set/v3/catalog.json"))
        self.assertFalse(validation.ready)
        self.assertTrue(any("0/5" in issue for issue in validation.issues))


if __name__ == "__main__":
    unittest.main()
