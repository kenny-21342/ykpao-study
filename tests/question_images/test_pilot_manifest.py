from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from pdf_extraction.question_images.cli import _compare
from pdf_extraction.question_images.models import DETECTOR_VERSION
from pdf_extraction.question_images.pilot import select_pilot, validate_signoff


ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    ROOT / "data/v3/manifests/all-caie-2026-07-27.json",
    ROOT / "data/v3/manifests/all-ib-2026-07-27.json",
]


class PilotManifestTests(unittest.TestCase):
    def test_real_pilot_has_100_papers_42_subjects_and_all_edge_families(self) -> None:
        if not all(path.is_file() for path in SOURCES):
            self.skipTest("Local source manifests are unavailable")
        first = select_pilot(SOURCES)
        second = select_pilot(SOURCES)
        self.assertEqual(first, second)
        self.assertEqual(first["selectedCount"], 100)
        self.assertEqual(first["representedSubjects"], 42)
        reasons = {
            reason
            for document in first["documents"]
            for reason in document["reasons"]
        }
        self.assertTrue({
            "caie_9709_q1_q3",
            "diagram_heavy_science",
            "multiple_choice",
            "essay_layout",
            "multilingual_layout",
            "scanned_2018_ib_economics",
        }.issubset(reasons))
        multilingual = [
            item for item in first["documents"]
            if "multilingual_layout" in item["reasons"]
        ]
        self.assertTrue(multilingual)
        self.assertTrue(all(item["board"] == "IB" for item in multilingual))

    def test_full_run_signoff_requires_every_gate(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "signoff.json"
            base = {
                "version": "QuestionImagePilotSignoffV1",
                "detectorVersion": DETECTOR_VERSION,
                "approved": True,
                "gates": {
                    "acceptedBoundaryPrecision": 1.0,
                    "rootDetectionRecall": 0.98,
                    "acceptedRootCoverage": 0.95,
                    "requiredMaterialRetention": 1.0,
                    "deterministicArtifacts": True,
                    "diskProjectionFits": True,
                },
            }
            path.write_text(json.dumps(base), encoding="utf-8")
            validate_signoff(path)
            base["gates"]["acceptedBoundaryPrecision"] = 0.99
            path.write_text(json.dumps(base), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "acceptedBoundaryPrecision"):
                validate_signoff(path)

    def test_compare_can_persist_determinism_report(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            report = root / "determinism.json"
            manifest.write_text(json.dumps({"records": []}), encoding="utf-8")

            self.assertEqual(_compare(manifest, manifest, output=report), 0)
            value = json.loads(report.read_text(encoding="utf-8"))
            self.assertTrue(value["deterministic"])
            self.assertEqual(value["detectorVersion"], DETECTOR_VERSION)
            self.assertEqual(value["mismatchedRecordIds"], [])
            self.assertEqual(value["firstManifestSha256"], value["secondManifestSha256"])


if __name__ == "__main__":
    unittest.main()
