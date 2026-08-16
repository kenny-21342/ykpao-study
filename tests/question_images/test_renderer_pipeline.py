from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fitz
from PIL import Image

from pdf_extraction.question_images.models import (
    CorpusManifest,
    QuestionImageRecord,
    SourceRegion,
    summarize,
)
from pdf_extraction.question_images.pipeline import (
    LowDiskSpaceError,
    PipelineConfig,
    process_document,
    run_batch,
)
from pdf_extraction.question_images.renderer import (
    MAXIMUM_HEIGHT,
    MINIMUM_DPI,
    choose_render_dpi,
    stitch_strips,
)


class RendererAndPipelineTests(unittest.TestCase):
    def test_stitching_has_fixed_white_separator_and_stable_pixels(self) -> None:
        first = Image.new("RGB", (20, 10), "black")
        second = Image.new("RGB", (10, 8), "red")
        stitched = stitch_strips([first, second])
        self.assertEqual(stitched.size, (20, 42))
        self.assertEqual(stitched.getpixel((0, 20)), (255, 255, 255))
        self.assertEqual(
            sha256(stitched.tobytes()).hexdigest(),
            sha256(stitch_strips([first, second]).tobytes()).hexdigest(),
        )

    def test_height_limit_reduces_dpi_then_quarantines(self) -> None:
        moderate = [SourceRegion(0, 1, (0, 0, 500, 12_000), 200)]
        selected = choose_render_dpi(moderate)
        self.assertIsNotNone(selected)
        self.assertGreaterEqual(selected or 0, MINIMUM_DPI)
        self.assertLess(selected or 999, 200)
        oversized = [SourceRegion(0, 1, (0, 0, 500, 20_000), 200)]
        self.assertIsNone(choose_render_dpi(oversized))
        self.assertEqual(MAXIMUM_HEIGHT, 30_000)

    def test_pipeline_preserves_color_and_is_content_addressed(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "color.pdf"
            _make_question_pdf(pdf, color=True)
            document = _document(pdf, "doc-color")
            config = PipelineConfig(root / "output", minimum_free_bytes=0)
            records = process_document(document, config)
            self.assertEqual([record.status for record in records], ["ACCEPTED", "ACCEPTED"])
            first = records[0]
            self.assertEqual(first.image["mode"], "color")  # type: ignore[index]
            asset = config.output_root / str(first.image["path"])  # type: ignore[index]
            self.assertTrue(asset.is_file())
            self.assertEqual(sha256(asset.read_bytes()).hexdigest(), first.image["sha256"])  # type: ignore[index]
            with Image.open(asset) as rendered:
                top_band = rendered.convert("RGB").crop((0, 0, rendered.width, 20))
                self.assertEqual(min(min(pixel) for pixel in top_band.getdata()), 255)
            repeated = process_document(document, config)
            self.assertEqual(
                [record.image["sha256"] for record in records],  # type: ignore[index]
                [record.image["sha256"] for record in repeated],  # type: ignore[index]
            )

    def test_disk_guard_stops_before_processing(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "guard.pdf"
            _make_question_pdf(pdf)
            with self.assertRaises(LowDiskSpaceError):
                process_document(
                    _document(pdf, "doc-guard"),
                    PipelineConfig(root / "output", minimum_free_bytes=10**30),
                )

    def test_batch_ledger_resume_and_manifest_are_deterministic(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "resume.pdf"
            _make_question_pdf(pdf)
            source_manifest = root / "source.json"
            source_manifest.write_text(json.dumps({
                "version": "V3ManifestV1",
                "documents": [_document(pdf, "doc-resume")],
            }), encoding="utf-8")
            config = PipelineConfig(root / "output", minimum_free_bytes=0)
            first = run_batch([source_manifest], config)
            manifest_bytes = Path(first.manifest_path).read_bytes()
            self.assertEqual(first.processed_documents, 1)
            self.assertEqual(first.resumed_documents, 0)
            second = run_batch([source_manifest], config)
            self.assertEqual(second.processed_documents, 0)
            self.assertEqual(second.resumed_documents, 1)
            self.assertEqual(Path(second.manifest_path).read_bytes(), manifest_bytes)
            ledger_lines = Path(second.ledger_path).read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(ledger_lines), 1)
            manifest = CorpusManifest.load(Path(second.manifest_path))
            self.assertEqual(len(manifest.records), 2)
            report = json.loads(Path(second.report_path).read_text(encoding="utf-8"))
            self.assertEqual(report["sourceQuestionPapers"], 1)
            self.assertIn("projectedAssetBytes", report)
            self.assertFalse(report["pilotGates"]["deterministicArtifacts"])

    def test_reprocessing_replaces_stale_detector_records(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "upgrade.pdf"
            _make_question_pdf(pdf)
            source_manifest = root / "source.json"
            source_manifest.write_text(json.dumps({
                "version": "V3ManifestV1",
                "documents": [_document(pdf, "doc-upgrade")],
            }), encoding="utf-8")
            config = PipelineConfig(root / "output", minimum_free_bytes=0)
            first = run_batch([source_manifest], config)

            ledger_path = Path(first.ledger_path)
            stale = json.loads(ledger_path.read_text(encoding="utf-8"))
            stale["detectorVersion"] = "question-image-detector-stale"
            for index, record in enumerate(stale["records"]):
                record["id"] = f"stale-record-{index}"
                record["detectorVersion"] = stale["detectorVersion"]
                record["status"] = "QUARANTINED"
                record["diagnostics"] = [{"reason": "stale_detector_result"}]
                record["image"] = None
            ledger_path.write_text(
                json.dumps(stale, sort_keys=True, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )

            upgraded = run_batch([source_manifest], config)
            manifest = CorpusManifest.load(Path(upgraded.manifest_path))
            self.assertEqual(upgraded.processed_documents, 1)
            self.assertEqual(len(manifest.records), 2)
            self.assertFalse(any(record.id.startswith("stale-record-") for record in manifest.records))
            self.assertTrue(all(record.status == "ACCEPTED" for record in manifest.records))

    def test_summary_counts_content_addressed_assets_once(self) -> None:
        shared_image = {
            "width": 10,
            "height": 10,
            "dpi": 200,
            "mode": "grayscale",
            "sha256": "a" * 64,
            "path": f"assets/sha256/aa/{'a' * 64}.png",
            "bytes": 1234,
            "separatorPixels": 24,
        }
        records = [
            QuestionImageRecord(
                id=f"record-{index}",
                paper_id=f"paper-{index}",
                document_id=f"document-{index}",
                source_path=f"paper-{index}.pdf",
                source_sha256=str(index) * 64,
                board="CAIE",
                subject_id="0000",
                subject_name="Synthetic",
                root_number="1",
                section="default",
                source_regions=[],
                status="ACCEPTED",
                confidence={},
                image=dict(shared_image),
            )
            for index in range(2)
        ]

        summary = summarize(records)
        self.assertEqual(summary["assetBytes"], 1234)
        self.assertEqual(summary["assetReferences"], 2)
        self.assertEqual(summary["uniqueAssets"], 1)


def _make_question_pdf(path: Path, color: bool = False) -> None:
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((294, 58), "2", fontsize=10)
    page.insert_text((50, 80), "1 Calculate the value shown in the diagram.", fontsize=11)
    shape = page.new_shape()
    shape.draw_rect(fitz.Rect(80, 120, 300, 250))
    shape.draw_line(fitz.Point(80, 185), fitz.Point(300, 185))
    shape.draw_line(fitz.Point(190, 120), fitz.Point(190, 250))
    shape.finish(color=(1, 0, 0) if color else (0, 0, 0), width=3)
    shape.commit()
    page.insert_text((80, 290), "." * 70 + " [3]", fontsize=10)
    page.insert_text((50, 430), "2 State one conclusion.", fontsize=11)
    page.insert_text((80, 470), "The conclusion must use the diagram. [1]", fontsize=10)
    document.save(path)
    document.close()


def _document(path: Path, document_id: str) -> dict:
    digest = sha256(path.read_bytes()).hexdigest()
    return {
        "id": document_id,
        "local_path": str(path),
        "sha256": digest,
        "metadata": {
            "board": "CAIE",
            "qualification": "Synthetic",
            "subject_id": "0000",
            "subject_name": "Synthetic",
            "level": "Test",
            "year": 2026,
            "session": "test",
            "paper_number": "1",
            "paper_type": "written",
            "component": "11",
            "variant": "1",
            "timezone": "",
            "language": "en",
            "document_type": "question_paper",
        },
    }


if __name__ == "__main__":
    unittest.main()
