from __future__ import annotations

from pathlib import Path
import unittest

from pdf_extraction.question_images.detector import detect_roots
from pdf_extraction.question_images.evidence import extract_document_evidence
from pdf_extraction.question_images.regions import build_source_regions


ROOT = Path(__file__).resolve().parents[2]


class RealSourceRegressionTests(unittest.TestCase):
    def test_caie_9709_detects_q1_q3_without_adjacent_overlap(self) -> None:
        path = ROOT / "pdf_extraction/my_raw_pdfs/a-level/mathematics-9709/9709_m16_qp_12.pdf"
        if not path.is_file():
            self.skipTest("Local CAIE corpus is unavailable")
        result = detect_roots(extract_document_evidence(path))
        numbers = [root.number for root in result.roots]
        self.assertEqual(numbers[:3], [1, 2, 3])
        self.assertFalse(any(
            diagnostic["reason"] == "adjacent_root_overlap"
            for root in result.roots for diagnostic in root.diagnostics
        ))

    def test_caie_math_boundary_includes_tall_same_row_formula(self) -> None:
        path = ROOT / "pdf_extraction/my_raw_pdfs/a-level/mathematics-9709/9709_s15_qp_13.pdf"
        if not path.is_file():
            self.skipTest("Local CAIE corpus is unavailable")
        result = detect_roots(extract_document_evidence(path))
        second = next(root for root in result.roots if root.number == 2)
        self.assertLess(second.candidate.bbox[1], 105)

        regions = build_source_regions(evidence := extract_document_evidence(path), result)
        self.assertGreaterEqual(regions[0].mark_allocations, 1)
        self.assertTrue(any("[3]" in line.text and line.furniture_reason is None
                            for line in evidence.pages[1].lines))

    def test_diagram_heavy_science_retains_native_visual_evidence(self) -> None:
        path = ROOT / "pdf_extraction/my_raw_pdfs/igcse/physics-0625/0625_m20_qp_52.pdf"
        if not path.is_file():
            self.skipTest("Local CAIE corpus is unavailable")
        evidence = extract_document_evidence(path)
        result = detect_roots(evidence)
        self.assertEqual([root.number for root in result.roots], [1, 2, 3, 4])
        self.assertGreater(sum(visual.essential for page in evidence.pages for visual in page.visuals), 10)

    def test_multiple_choice_distractor_numbers_do_not_enter_the_root_sequence(self) -> None:
        path = ROOT / "pdf_extraction/my_raw_pdfs/igcse/biology-0610/0610_s15_qp_12.pdf"
        if not path.is_file():
            self.skipTest("Local CAIE corpus is unavailable")
        result = detect_roots(extract_document_evidence(path))
        numbers = [root.number for root in result.roots]
        self.assertEqual(numbers[:15], list(range(1, 16)))
        self.assertEqual(numbers.count(2), 1)
        self.assertGreater(sum(candidate.number == 2 for candidate in result.candidates), 1)

    def test_ib_essay_layout_detects_only_the_two_prompt_roots(self) -> None:
        path = ROOT / (
            "pdf_extraction/IB PAST PAPERS - YEAR/2016 Examination Session/"
            "May 2016 Examination Session/Group 1 - Studies in Language and Literature/"
            "English_A_Language_and_literature_paper_1__HL.pdf"
        )
        if not path.is_file():
            self.skipTest("Local IB corpus is unavailable")
        result = detect_roots(extract_document_evidence(path))
        self.assertEqual([root.number for root in result.roots], [1, 2])
        self.assertFalse(any(root.quarantined for root in result.roots))

    def test_ib_multilingual_layout_resets_simplified_and_traditional_sections(self) -> None:
        path = ROOT / (
            "pdf_extraction/IB PAST PAPERS - YEAR/2016 Examination Session/"
            "May 2016 Examination Session/Group 1 - Studies in Language and Literature/"
            "Chinese_A_Language_and_literature_paper_1__HL.pdf"
        )
        if not path.is_file():
            self.skipTest("Local IB corpus is unavailable")
        result = detect_roots(extract_document_evidence(path))
        self.assertEqual(
            [(root.candidate.section, root.number) for root in result.roots],
            [("SIMPLIFIED", 1), ("SIMPLIFIED", 2), ("TRADITIONAL", 1), ("TRADITIONAL", 2)],
        )
        self.assertFalse(any(root.quarantined for root in result.roots))
        regions = build_source_regions(extract_document_evidence(path), result)
        self.assertNotIn(5, {region.page for region in regions[0].regions})

    def test_scanned_2018_ib_economics_uses_english_ocr(self) -> None:
        path = ROOT / (
            "pdf_extraction/IB PAST PAPERS - YEAR/2018 Examination Session/"
            "May 2018 Examination Session/Individuals and societies/Economics_paper_2__HL.pdf"
        )
        if not path.is_file():
            self.skipTest("Local IB corpus is unavailable")
        evidence = extract_document_evidence(path, language="en")
        self.assertEqual(evidence.native_text_characters, 0)
        self.assertTrue(evidence.used_ocr)
        result = detect_roots(evidence)
        self.assertGreaterEqual(len(result.roots), 2)


if __name__ == "__main__":
    unittest.main()
