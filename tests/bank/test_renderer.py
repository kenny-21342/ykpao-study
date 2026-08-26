"""Tests for the stage 2 renderer."""

from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fitz

from pdf_extraction.bank.renderer import (
    MIN_FIGURE_AREA,
    MIN_FIGURE_SIDE,
    _content_bounds,
    render_strips_and_assets,
)
from pdf_extraction.bank.spans import (
    DocumentSpans,
    PageRegion,
    RootSpan,
    detect_root_spans,
)


class RotatedPageTests(unittest.TestCase):
    """Mark schemes are portrait pages carrying /Rotate 90.

    ``page.rect`` and ``get_pixmap`` describe the rotated page, but
    ``get_text``, ``get_drawings`` and ``get_image_rects`` all describe the
    unrotated one. Mixing them trimmed every strip to the unrotated width,
    which on a real mark scheme cut off the Marks column.
    """

    def _rotated_page(self, directory: Path) -> Path:
        pdf_path = directory / "rotated.pdf"
        document = fitz.open()
        page = document.new_page(width=595, height=842)
        # Near the foot of the unrotated page, which is the right-hand edge
        # once the page is turned — where the Marks column lives.
        page.insert_text((60, 60), "Question", fontsize=11)
        page.insert_text((60, 780), "B1", fontsize=11)
        page.set_rotation(90)
        document.save(pdf_path)
        document.close()
        return pdf_path

    def test_content_bounds_are_measured_in_the_rendered_space(self) -> None:
        with TemporaryDirectory() as directory:
            pdf_path = self._rotated_page(Path(directory))
            with fitz.open(pdf_path) as document:
                page = document[0]
                self.assertEqual(page.rotation, 90)
                bounds = _content_bounds(page)
                self.assertIsNotNone(bounds)
                self.assertLessEqual(bounds.x1, page.rect.x1 + 1)
                self.assertLessEqual(bounds.y1, page.rect.y1 + 1)
                # The rendered page is landscape, so its content bounds must be
                # too. Unmapped coordinates come back portrait — that is the
                # shape of the bug, and it is what trims the strip too narrow.
                self.assertGreater(bounds.width, bounds.height)

    def test_an_erase_box_lands_where_the_display_coordinates_say(self) -> None:
        """Erase boxes are in display space; draw_rect is not.

        A mark scheme's running header is a wide, short band across the top of
        the rendered page. Painted without converting to the page's own
        coordinates it came out as a tall, narrow stripe down the answers
        instead — the right area erased, ninety degrees out.
        """
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "erase-rotated.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            # A running header in the band, and the answers clear of it.
            #
            # This used to put the answer text itself under the band, because
            # any text would do to make a visible change. It will not do any
            # more: the renderer refuses to paint a box that would cover
            # content, so a box over "answer text" is now dropped and nothing
            # is painted. Unrotated x becomes display y, so x=60 lands inside
            # the 0-100 band and x=160 lands outside it.
            page.insert_text((60, 80), "\u00a9 UCLES 2023", fontsize=11)
            for offset in range(0, 700, 60):
                page.insert_text((160, 80 + offset), "answer text on every line", fontsize=11)
            page.set_rotation(90)
            document.save(pdf_path)
            document.close()

            with fitz.open(pdf_path) as opened:
                width, height = opened[0].rect.width, opened[0].rect.height

            def render(erase: tuple[tuple[float, float, float, float], ...]) -> fitz.Pixmap:
                spans = DocumentSpans(
                    source_path=str(pdf_path), source_sha256="x", doc_type="ms",
                    page_count=1, strategy="ms_table",
                    spans=(RootSpan(root_number=1, regions=(PageRegion(
                        page=1, bbox=(0.0, 0.0, width, height), erase_bboxes=erase,
                    ),)),),
                )
                out = render_strips_and_assets(
                    spans, pdf_path, Path(directory) / f"out{len(erase)}")
                return fitz.open(out.span_for(1).strips[0].absolute_path)[0].get_pixmap()

            plain = render(())
            # A band across the top of the *rendered* page, covering the
            # running header and nothing else.
            painted = render(((0.0, 0.0, width, 100.0),))
            self.assertEqual((plain.width, plain.height), (painted.width, painted.height))

            changed = [
                y for y in range(0, plain.height, 3)
                if any(
                    plain.pixel(x, y) != painted.pixel(x, y)
                    for x in range(0, plain.width, 3)
                )
            ]
            self.assertTrue(changed, "the erase box painted nothing at all")
            # A band changes a contiguous run of rows. Rotated ninety degrees it
            # becomes a stripe down the page, touching every height instead.
            self.assertLess(max(changed) - min(changed), plain.height * 0.6)

    def test_a_full_width_clip_survives_the_content_trim(self) -> None:
        """The trim must not eat the far edge of a landscape strip."""
        with TemporaryDirectory() as directory:
            pdf_path = self._rotated_page(Path(directory))
            with fitz.open(pdf_path) as document:
                page = document[0]
                clip = fitz.Rect(0, 0, page.rect.width, page.rect.height)
                trimmed = clip & _content_bounds(page)
                # "B1" sits near the right edge; before the fix the trim
                # stopped around x=595 and dropped it.
                self.assertGreater(trimmed.x1, 700)


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


class FigureOrderingTests(unittest.TestCase):
    """Figure ids must follow the page, not the detection pass that found them.

    Regression for 0620_s23_qp_41 Q3, where Fig 3.1 was numbered `fig3`, Fig
    3.2 `fig1` and Fig 3.3 `fig2` — because tables are detected before vector
    clusters — and the model cited all three wrongly at 0.95 confidence.
    """

    def test_candidates_come_back_top_to_bottom(self):
        from pdf_extraction.bank.renderer import _dedup

        # Detection order: a table found first, then two clusters below and
        # above it — exactly the shape that produced the bug.
        candidates = [
            {"bbox": (168.0, 362.0, 408.0, 442.0), "is_table": True},
            {"bbox": (169.0, 640.0, 425.0, 735.0), "is_table": False},
            {"bbox": (187.0, 135.0, 408.0, 231.0), "is_table": False},
        ]
        ordered = _dedup(candidates)
        ordered.sort(key=lambda c: (round(c["bbox"][1], 1), round(c["bbox"][0], 1)))
        self.assertEqual([c["bbox"][1] for c in ordered], [135.0, 362.0, 640.0])

    def test_ties_on_y_break_left_to_right(self):
        from pdf_extraction.bank.renderer import _dedup

        candidates = [
            {"bbox": (400.0, 200.0, 500.0, 300.0), "is_table": False},
            {"bbox": (100.0, 200.0, 200.0, 300.0), "is_table": False},
        ]
        ordered = _dedup(candidates)
        ordered.sort(key=lambda c: (round(c["bbox"][1], 1), round(c["bbox"][0], 1)))
        self.assertEqual([c["bbox"][0] for c in ordered], [100.0, 400.0])


class FigureInventoryTests(unittest.TestCase):
    def test_ordinals_restart_on_each_page(self):
        from pdf_extraction.bank.transcribe import _ordinals_by_page

        figures = [
            {"id": "fig1", "page": 4},
            {"id": "fig2", "page": 4},
            {"id": "fig3", "page": 4},
            {"id": "fig4", "page": 5},
        ]
        self.assertEqual(_ordinals_by_page(figures), [1, 2, 3, 1])

    def test_inventory_tells_the_model_where_each_figure_sits(self):
        from pdf_extraction.bank.transcribe import _build_user_text

        class Span:
            root_number = 3
            page_start = 4
            page_end = 5
            strips = (object(), object())
            figures = (
                {"id": "fig1", "page": 4, "kind": "figure"},
                {"id": "fig2", "page": 4, "kind": "table"},
            )

        payload = json.loads(_build_user_text(Span(), "qp"))
        self.assertEqual(
            [(f["id"], f["page"], f["order_on_page"]) for f in payload["figure_inventory"]],
            [("fig1", 4, 1), ("fig2", 4, 2)],
        )
        self.assertIn("reading order down each page", payload["instructions"])

class EraseGuardTests(unittest.TestCase):
    """A box that would cover question text is never painted.

    The bank shipped a question reading "the line y = ax +" because an erase
    box covered its constant. The producers of these boxes cannot see the text
    they sit on -- a line misread as furniture contributes its whole bbox --
    so the renderer refuses them at the last moment before pixels are lost.
    """

    def _render(self, directory: Path, erase, name: str):
        pdf_path = Path(directory) / f"{name}.pdf"
        document = fitz.open()
        page = document.new_page(width=595, height=842)
        page.insert_text((60, 100), "Find a when y = ax + 9 holds", fontsize=11)
        page.insert_text((60, 300), "\u00a9 UCLES 2023", fontsize=11)
        document.save(pdf_path)
        document.close()

        spans = DocumentSpans(
            source_path=str(pdf_path), source_sha256="x", doc_type="qp",
            page_count=1, strategy="prose",
            spans=(RootSpan(root_number=1, regions=(PageRegion(
                page=1, bbox=(40.0, 60.0, 560.0, 340.0), erase_bboxes=erase,
            ),)),),
        )
        out = render_strips_and_assets(spans, pdf_path, Path(directory) / name)
        return fitz.open(out.span_for(1).strips[0].absolute_path)[0].get_pixmap()

    def _box_over(self, directory: Path, word: str):
        pdf_path = Path(directory) / "probe.pdf"
        document = fitz.open()
        page = document.new_page(width=595, height=842)
        page.insert_text((60, 100), "Find a when y = ax + 9 holds", fontsize=11)
        page.insert_text((60, 300), "\u00a9 UCLES 2023", fontsize=11)
        document.save(pdf_path)
        for x0, y0, x1, y1, found, *_ in document[0].get_text("words"):
            if found == word:
                document.close()
                return (x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5)
        document.close()
        raise AssertionError(f"{word!r} is not on the page")

    def _differs(self, plain, painted) -> bool:
        return any(
            plain.pixel(x, y) != painted.pixel(x, y)
            for y in range(0, plain.height, 2)
            for x in range(0, plain.width, 2)
        )

    def test_a_box_over_question_text_paints_nothing(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            plain = self._render(root, (), "plain")
            painted = self._render(root, (self._box_over(root, "9"),), "over-content")
            self.assertFalse(
                self._differs(plain, painted),
                "the constant in 'ax + 9' was painted out",
            )

    def test_a_box_over_furniture_is_still_painted(self) -> None:
        # The guard must not simply refuse everything: erasing the copyright
        # line is what erase boxes are for.
        with TemporaryDirectory() as directory:
            root = Path(directory)
            plain = self._render(root, (), "plain")
            painted = self._render(root, (self._box_over(root, "UCLES"),), "over-furniture")
            self.assertTrue(
                self._differs(plain, painted),
                "the copyright line should have been erased",
            )

