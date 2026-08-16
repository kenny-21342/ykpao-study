"""Tests for the stage 2 renderer."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fitz

from pdf_extraction.bank.renderer import (
    MIN_FIGURE_AREA,
    MIN_FIGURE_SIDE,
    render_strips_and_assets,
)
from pdf_extraction.bank.spans import (
    DocumentSpans,
    PageRegion,
    RootSpan,
    detect_root_spans,
)


class RendererTests(unittest.TestCase):
    def test_renders_strips_for_multi_page_questions(self) -> None:
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "test.pdf"
            document = fitz.open()
            first = document.new_page(width=595, height=842)
            first.insert_text((50, 80), "1 Find the value of x.", fontsize=11)
            second = document.new_page(width=595, height=842)
            second.insert_text((50, 70), "Question 1 continued", fontsize=11)
            second.insert_text((75, 110), "Show all required working.", fontsize=11)
            third = document.new_page(width=595, height=842)
            third.insert_text((50, 80), "2 State the value of y.", fontsize=11)
            document.save(pdf_path)
            document.close()

            spans = detect_root_spans(pdf_path, "qp")
            output = render_strips_and_assets(spans, pdf_path, Path(directory) / "assets")

            first_question = output.span_for(1)
            self.assertIsNotNone(first_question)
            self.assertEqual({strip.page for strip in first_question.strips}, {1, 2})

            second_question = output.span_for(2)
            self.assertIsNotNone(second_question)
            self.assertEqual({strip.page for strip in second_question.strips}, {3})

    def test_strip_covers_the_span_not_the_whole_page(self) -> None:
        """A strip must be cropped to its question.

        Rendering full page height regardless of span size multiplied vision
        tokens several-fold for no extra information, which is precisely the
        waste this pipeline exists to avoid.
        """
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "short.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 80), "1 State the value of x.", fontsize=11)
            page.insert_text((50, 700), "2 State the value of y.", fontsize=11)
            document.save(pdf_path)
            document.close()

            spans = detect_root_spans(pdf_path, "qp")
            output = render_strips_and_assets(spans, pdf_path, Path(directory) / "assets")

            strip = output.span_for(1).strips[0]
            height = strip.bbox[3] - strip.bbox[1]
            self.assertLess(height, 842 * 0.9, "strip should not span the whole page")

    def test_strips_are_written_to_disk_at_absolute_paths(self) -> None:
        """Stage 3 loads these by path, so they must resolve from any cwd."""
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "test.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 80), "1 Calculate x.", fontsize=11)
            document.save(pdf_path)
            document.close()

            spans = detect_root_spans(pdf_path, "qp")
            output = render_strips_and_assets(spans, pdf_path, Path(directory) / "assets")

            for strip in output.span_for(1).strips:
                self.assertTrue(Path(strip.absolute_path).is_absolute())
                self.assertTrue(Path(strip.absolute_path).is_file())

    def test_scattered_vector_paths_become_one_figure(self) -> None:
        """A diagram drawn as many separate strokes must not fragment.

        PyMuPDF reports every path separately, so an unclustered detector
        either emitted dozens of slivers or discarded them all as too small,
        losing the diagram.
        """
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "figure.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 80), "1 The diagram shows a shape.", fontsize=11)
            # A cluster of small strokes, each individually below the minimum
            # figure size, together forming one ~120x120pt diagram.
            for row in range(6):
                for column in range(6):
                    x = 120 + column * 20
                    y = 200 + row * 20
                    page.draw_rect(fitz.Rect(x, y, x + 12, y + 12), width=1)
            page.insert_text((50, 500), "2 State the answer.", fontsize=11)
            document.save(pdf_path)
            document.close()

            spans = detect_root_spans(pdf_path, "qp")
            output = render_strips_and_assets(spans, pdf_path, Path(directory) / "assets")

            figures = output.span_for(1).figures
            self.assertEqual(len(figures), 1, "strokes should cluster into one figure")

            bbox = figures[0]["bbox"]
            width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
            self.assertGreaterEqual(min(width, height), MIN_FIGURE_SIDE)
            self.assertGreaterEqual(width * height, MIN_FIGURE_AREA)

    def test_erase_boxes_are_painted_out_before_render(self) -> None:
        """Answer rules must not reach the model.

        Stage 1 marks them; ignoring the marks meant the model still saw the
        dotted lines it was told to skip.
        """
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "erase.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((60, 200), "." * 90, fontsize=11)
            document.save(pdf_path)
            document.close()

            region = PageRegion(page=1, bbox=(40.0, 180.0, 560.0, 240.0))
            erased = PageRegion(
                page=1,
                bbox=(40.0, 180.0, 560.0, 240.0),
                erase_bboxes=((50.0, 185.0, 555.0, 235.0),),
            )
            base = DocumentSpans(
                source_path=str(pdf_path), source_sha256="x", doc_type="qp",
                page_count=1, strategy="prose",
                spans=(RootSpan(root_number=1, regions=(region,)),),
            )
            with_erase = DocumentSpans(
                source_path=str(pdf_path), source_sha256="x", doc_type="qp",
                page_count=1, strategy="prose",
                spans=(RootSpan(root_number=1, regions=(erased,)),),
            )

            plain = render_strips_and_assets(base, pdf_path, Path(directory) / "a")
            painted = render_strips_and_assets(with_erase, pdf_path, Path(directory) / "b")

            self.assertNotEqual(
                plain.span_for(1).strips[0].sha256,
                painted.span_for(1).strips[0].sha256,
                "erasing the answer rule must change the rendered pixels",
            )

    def test_assets_are_content_addressed(self) -> None:
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "test.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 80), "1 Calculate x.", fontsize=11)
            document.save(pdf_path)
            document.close()

            spans = detect_root_spans(pdf_path, "qp")
            asset_root = Path(directory) / "assets"
            first = render_strips_and_assets(spans, pdf_path, asset_root)
            second = render_strips_and_assets(spans, pdf_path, asset_root)

            self.assertEqual(
                {asset.sha256 for asset in first.assets},
                {asset.sha256 for asset in second.assets},
            )

    def test_empty_document_returns_no_output(self) -> None:
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "empty.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 80), "Some content without questions", fontsize=11)
            document.save(pdf_path)
            document.close()

            spans = detect_root_spans(pdf_path, "qp")
            output = render_strips_and_assets(spans, pdf_path, Path(directory) / "assets")

            self.assertEqual(len(output.rendered_spans), 0)
            self.assertEqual(len(output.assets), 0)


if __name__ == "__main__":
    unittest.main()
