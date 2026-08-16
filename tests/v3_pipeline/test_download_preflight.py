from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fitz

from pdf_extraction.v3.download import DownloadPolicy, ResumableDownloader
from pdf_extraction.v3.metadata import parse_caie_filename
from pdf_extraction.v3.models import CorpusManifest, ManifestDocument
from pdf_extraction.v3.pdf import preflight_pdf, validate_pdf


def make_pdf(path: Path) -> bytes:
    document = fitz.open()
    for page_number in (1, 2):
        page = document.new_page(width=595, height=842)
        page.insert_text((48, 35), "Cambridge International Examination")
        page.insert_text((48, 90), f"{page_number} Question content on page {page_number}")
        page.insert_text((48, 800), "TURN OVER" if page_number == 1 else "© UCLES 2026")
        shape = page.new_shape()
        shape.draw_rect(fitz.Rect(120, 180, 360, 330))
        shape.draw_line(fitz.Point(120, 255), fitz.Point(360, 255))
        shape.draw_line(fitz.Point(240, 180), fitz.Point(240, 330))
        shape.finish(width=2)
        shape.commit()
        page.draw_line(fitz.Point(60, 720), fitz.Point(530, 720), width=1)
    document.save(path)
    document.close()
    return path.read_bytes()


class FakeResponse:
    def __init__(self, payload: bytes, status_code: int = 206) -> None:
        self.payload = payload
        self.status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size: int):
        for offset in range(0, len(self.payload), chunk_size):
            yield self.payload[offset:offset + chunk_size]


class FakeSession:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.headers = None
        self.timeout = None

    def get(self, _url, *, headers, stream, timeout):
        self.headers = headers
        self.timeout = timeout
        self.assert_stream = stream
        return FakeResponse(self.payload)


class DownloadPreflightTests(unittest.TestCase):
    def test_validation_accepts_leading_package_bytes_before_pdf_header(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.pdf"
            payload = make_pdf(source)
            source.write_bytes(b"\r\r\x00\x00package-prefix" + payload)
            validation = validate_pdf(source)
            self.assertTrue(validation.valid)
            self.assertEqual(validation.page_count, 2)

    def test_resumable_download_uses_range_and_required_timeouts(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.pdf"
            payload = make_pdf(source)
            destination = root / "download.pdf"
            partial = destination.with_suffix(".pdf.part")
            split = len(payload) // 3
            partial.write_bytes(payload[:split])
            metadata = parse_caie_filename("9709_s23_qp_12.pdf")
            entry = ManifestDocument(metadata, source_url="https://example.test/paper.pdf")
            manifest = CorpusManifest("test", "authoritative", {entry.id: entry})
            manifest_path = root / "manifest.json"
            manifest.save(manifest_path)
            session = FakeSession(payload[split:])
            policy = DownloadPolicy(connect_timeout_seconds=30, read_timeout_seconds=300, retries=5)
            ResumableDownloader(policy, session=session, sleep=lambda _delay: None).download(entry, destination, manifest, manifest_path)
            self.assertEqual(session.headers["Range"], f"bytes={split}-")
            self.assertEqual(session.timeout, (30, 300))
            self.assertEqual(entry.status, "ready")
            self.assertEqual(destination.read_bytes(), payload)
            self.assertTrue(validate_pdf(destination).valid)

    def test_preflight_renders_200_dpi_and_removes_repeated_furniture(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "paper.pdf"
            make_pdf(pdf)
            report = preflight_pdf(pdf, root / "work", "doc-test", "question_paper")
            self.assertEqual(report["renderDpi"], 200)
            self.assertEqual(len(report["pages"]), 2)
            self.assertIn("Cambridge International Examination", report["repeatedFurniture"])
            accepted = [block["text"] for block in report["pages"][0]["acceptedBlocks"]]
            self.assertNotIn("Cambridge International Examination", accepted)
            self.assertTrue(report["pages"][0]["figureCandidates"])
            self.assertTrue((root / "work/pages/page-0001.jpg").exists())


if __name__ == "__main__":
    unittest.main()
