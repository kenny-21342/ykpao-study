from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import fitz

from pdf_extraction.question_images.detector import detect_roots
from pdf_extraction.question_images.evidence import extract_document_evidence
from pdf_extraction.question_images.regions import build_source_regions


class DetectorAndRegionTests(unittest.TestCase):
    def test_sequence_decoder_ignores_measurements_and_supports_section_resets(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "sections.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 70), "SECTION A", fontsize=12)
            page.insert_text((50, 105), "1 Calculate the first value.", fontsize=11)
            page.insert_text((50, 145), "2 State the second value.", fontsize=11)
            page.insert_text((310, 165), "3 hours", fontsize=11)
            page.insert_text((50, 220), "SECTION B", fontsize=12)
            page.insert_text((50, 255), "1 Explain the result.", fontsize=11)
            page.insert_text((50, 300), "2 Discuss the conclusion.", fontsize=11)
            document.save(path)
            document.close()

            result = detect_roots(extract_document_evidence(path))
            self.assertEqual(
                [(root.candidate.section, root.number) for root in result.roots],
                [("A", 1), ("A", 2), ("B", 1), ("B", 2)],
            )
            self.assertFalse(any(root.quarantined for root in result.roots))

    def test_continuation_pages_and_multiple_questions_per_page(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "continuation.pdf"
            document = fitz.open()
            first = document.new_page(width=595, height=842)
            first.insert_text((50, 80), "1 Find the value of x.", fontsize=11)
            second = document.new_page(width=595, height=842)
            second.insert_text((50, 70), "Question 1 continued", fontsize=11)
            second.insert_text((75, 110), "Show all required working.", fontsize=11)
            second.insert_text((50, 260), "2 State the value of y.", fontsize=11)
            second.insert_text((50, 430), "3 Explain the final result.", fontsize=11)
            document.save(path)
            document.close()

            evidence = extract_document_evidence(path)
            detection = detect_roots(evidence)
            self.assertEqual([root.number for root in detection.roots], [1, 2, 3])
            self.assertFalse(any(
                diagnostic["reason"] == "missing_continuation"
                for root in detection.roots for diagnostic in root.diagnostics
            ))
            regions = build_source_regions(evidence, detection)
            self.assertEqual({region.page for region in regions[0].regions}, {1, 2})
            self.assertTrue(all(
                region.bbox[3] <= 260
                for region in regions[0].regions if region.page == 2
            ))
            first_question_end = max(
                region.bbox[3] for region in regions[0].regions if region.page == 2
            )
            self.assertLess(first_question_end, detection.roots[1].candidate.bbox[1])

    def test_response_space_is_compacted_but_marks_and_table_are_retained(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "response.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 70), "1 Complete the table and explain your answer.", fontsize=11)
            page.draw_rect(fitz.Rect(80, 110, 320, 230), width=1)
            page.draw_line(fitz.Point(80, 170), fitz.Point(320, 170), width=1)
            page.draw_line(fitz.Point(200, 110), fitz.Point(200, 230), width=1)
            page.insert_text((80, 270), "." * 80, fontsize=10)
            page.insert_text((80, 500), "." * 70 + " [4]", fontsize=10)
            page.insert_text((80, 540), "adaptation " + "." * 60, fontsize=10)
            page.insert_text((50, 650), "2 State one conclusion.", fontsize=11)
            document.save(path)
            document.close()

            evidence = extract_document_evidence(path)
            detection = detect_roots(evidence)
            regions = build_source_regions(evidence, detection)
            first = regions[0]
            self.assertGreaterEqual(first.essential_visuals, 3)
            self.assertEqual(first.mark_allocations, 1)
            self.assertGreaterEqual(first.response_lines_removed, 3)
            self.assertGreaterEqual(len(first.regions), 2)
            self.assertLess(
                sum(region.bbox[3] - region.bbox[1] for region in first.regions),
                450,
            )
            self.assertTrue(any(region.erase_bboxes for region in first.regions))
            labelled = next(
                line for line in evidence.pages[0].lines
                if line.response_erase_bboxes and line.text.startswith("adaptation")
            )
            rule = labelled.response_erase_bboxes[0]
            self.assertGreater(rule[0], labelled.bbox[0] + 35)
            # The word before the rule must survive it. Measuring the rule from
            # Helvetica metrics used to overshoot and clip the last letters.
            word_width = fitz.get_text_length("adaptation", fontsize=10)
            self.assertGreaterEqual(rule[0], labelled.bbox[0] + word_width - 1.0)

            marked = next(
                line for line in evidence.pages[0].lines
                if line.response_erase_bboxes and line.text.rstrip().endswith("[4]")
            )
            # A mark allocation printed at the end of a rule keeps its space.
            self.assertLess(marked.response_erase_bboxes[0][2], marked.bbox[2] - 8.0)

    def test_prose_in_the_header_band_is_not_mistaken_for_a_paper_code(self) -> None:
        """A question stem that continues onto a new page must survive.

        The paper-code pattern used to be case-insensitive, so "a 5000 metre
        race" and "than 100 years" both matched it. Any stem unlucky enough to
        start a page was erased whole, which silently made the question
        unanswerable in the bank.
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "header-band.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((72, 60), "0625/42/O/N/19", fontsize=9)
            page.insert_text((72, 74), "(c) The athlete then ran a 5000 metre race.", fontsize=11)
            page.insert_text((50, 300), "1 State the first answer.", fontsize=11)
            document.save(path)
            document.close()

            pages = extract_document_evidence(path).pages
            stem = next(line for line in pages[0].lines if "5000" in line.text)
            self.assertIsNone(stem.furniture_reason)
            code = next(line for line in pages[0].lines if line.text.startswith("0625/"))
            self.assertEqual(code.furniture_reason, "paper_code")

    def test_a_rule_never_eats_the_words_on_either_side_of_it(self) -> None:
        """Rule boxes come from glyph positions, not from font-metric guesses.

        The line is set in Courier on purpose. The old code estimated where the
        dots began by measuring the text before them in Helvetica, so it only
        landed correctly when the page happened to be set in Helvetica too — on
        a real CAIE paper it drifted, erasing "mi" from "minutes".
        """
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rule-bounds.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text(
                (72, 100),
                "It takes " + "." * 30 + " minutes to cool.",
                fontsize=11,
                fontname="cour",
            )
            document.save(path)
            document.close()

            page_evidence = extract_document_evidence(path).pages[0]
            line = next(line for line in page_evidence.lines if "minutes" in line.text)
            self.assertEqual(len(line.response_erase_bboxes), 1)
            rule = line.response_erase_bboxes[0]

            words = fitz.open(path)[0].get_text("words")
            takes = next(word for word in words if word[4] == "takes")
            minutes = next(word for word in words if word[4] == "minutes")
            self.assertGreaterEqual(rule[0], takes[2])
            self.assertLessEqual(rule[2], minutes[0])

    def test_ocr_rules_are_measured_from_tesseract_word_boxes(self) -> None:
        """Scanned pages were the last place still guessing at rule position."""
        from pdf_extraction.question_images.evidence import _rule_bboxes_from_words

        words = [
            {"text": "State", "left": "100", "top": "200", "width": "60", "height": "20"},
            {"text": ".........", "left": "170", "top": "205", "width": "300", "height": "10"},
            {"text": "[2]", "left": "480", "top": "200", "width": "30", "height": "20"},
        ]
        boxes = _rule_bboxes_from_words(words, 0.5)
        self.assertEqual(len(boxes), 1)
        rule = boxes[0]
        # Measured off the dots alone: neither neighbour is touched.
        self.assertGreaterEqual(rule[0], 100 * 0.5 + 60 * 0.5)
        self.assertLessEqual(rule[2], 480 * 0.5)

        # No rule on the line means "no measurement", not "an empty rule" —
        # the caller falls back rather than erasing a guessed rectangle.
        self.assertIsNone(_rule_bboxes_from_words(words[:1], 0.5))

    def test_sequence_gap_is_quarantined(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "gap.pdf"
            document = fitz.open()
            page = document.new_page(width=595, height=842)
            page.insert_text((50, 80), "1 State the first answer.", fontsize=11)
            page.insert_text((50, 180), "3 State the third answer.", fontsize=11)
            document.save(path)
            document.close()
            result = detect_roots(extract_document_evidence(path))
            self.assertEqual([root.number for root in result.roots], [1, 3])
            self.assertTrue(result.roots[0].quarantined)
            self.assertFalse(result.roots[1].quarantined)
            self.assertTrue(any(
                diagnostic["reason"] == "sequence_gap"
                for root in result.roots for diagnostic in root.diagnostics
            ))

    def test_multilingual_version_resets_do_not_confuse_article_line_numbers(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "versions.pdf"
            document = fitz.open()
            simplified = document.new_page(width=595, height=842)
            simplified.insert_text((200, 55), "Simplified version", fontsize=12)
            simplified.insert_text((45, 100), "1.", fontsize=11)
            simplified.insert_text((75, 100), "First prompt in this version.", fontsize=11)
            simplified.insert_text((60, 240), "5", fontsize=10)
            simplified.insert_text((110, 240), "article line without prompt language", fontsize=10)
            simplified.insert_text((45, 360), "2.", fontsize=11)
            simplified.insert_text((75, 360), "Second prompt in this version.", fontsize=11)
            traditional = document.new_page(width=595, height=842)
            traditional.insert_text((200, 55), "Traditional version", fontsize=12)
            traditional.insert_text((45, 100), "1.", fontsize=11)
            traditional.insert_text((75, 100), "First alternate prompt.", fontsize=11)
            traditional.insert_text((45, 360), "2.", fontsize=11)
            traditional.insert_text((75, 360), "Second alternate prompt.", fontsize=11)
            document.save(path)
            document.close()

            result = detect_roots(extract_document_evidence(path))
            self.assertEqual(
                [(root.candidate.section, root.number) for root in result.roots],
                [("SIMPLIFIED", 1), ("SIMPLIFIED", 2), ("TRADITIONAL", 1), ("TRADITIONAL", 2)],
            )
            self.assertFalse(any(root.quarantined for root in result.roots))


if __name__ == "__main__":
    unittest.main()
