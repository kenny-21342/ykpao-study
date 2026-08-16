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
                if line.response_erase_bbox and line.text.startswith("adaptation")
            )
            self.assertGreater(labelled.response_erase_bbox[0], labelled.bbox[0] + 35)  # type: ignore[index]

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
