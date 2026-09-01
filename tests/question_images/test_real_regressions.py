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


    HISTORY = "pdf_extraction/my_raw_pdfs/igcse/history-0470/0470_s16_qp_12.pdf"

    def _history_regions(self):
        path = ROOT / self.HISTORY
        if not path.is_file():
            self.skipTest("Local CAIE corpus is unavailable")
        evidence = extract_document_evidence(path)
        return build_source_regions(evidence, detect_roots(evidence))

    def test_a_section_heading_belongs_only_to_the_first_question_under_it(self) -> None:
        """Every question under a heading used to start its crop at that heading.

        On this paper questions 2, 6, 7, 9, 10, 12, 14, 16, 18, 20 and 22 each
        began at "SECTION A: CORE CONTENT" and so rendered the whole of the
        question before them -- eleven of twenty-two showing someone else's
        text. Only a cap of 35% of page height stopped the rest, which is why
        questions further down a page happened to come out right.
        """
        by_root = {entry.root.number: entry.regions for entry in self._history_regions()}
        first, second = by_root[1][0], by_root[2][0]
        self.assertEqual(first.page, second.page)
        # Question 2 starts where question 1 ends, not at the top of the page.
        self.assertGreaterEqual(second.bbox[1], first.bbox[3])

    def test_no_two_questions_share_a_region_of_the_page(self) -> None:
        spans = []
        for entry in self._history_regions():
            for region in entry.regions:
                spans.append((region.page, region.bbox[1], region.bbox[3], entry.root.number))
        spans.sort()
        for (page, top, bottom, root), (next_page, next_top, _, next_root) in zip(spans, spans[1:]):
            if page != next_page:
                continue
            self.assertLessEqual(
                bottom, next_top,
                f"question {root} overlaps question {next_root} on page {page}")

    def test_a_section_rubric_stays_out_of_the_question_above_it(self) -> None:
        """"Answer any one question from this Section." is bold but not capitals.

        The capitalisation test caught the heading and let the rubric through,
        so question 8 gained a region on page 4 containing nothing but question
        9's instruction, and question 9's own crop was split in two around it.
        """
        by_root = {entry.root.number: entry.regions for entry in self._history_regions()}
        self.assertEqual([region.page for region in by_root[8]], [3])
        self.assertEqual(len(by_root[9]), 1)

    def test_a_question_keeps_the_heading_that_names_its_topic(self) -> None:
        """The crop must still reach up to "DEPTH STUDY A: THE FIRST WORLD WAR".

        Without it the question reads "Military tactics were important on the
        Western Front" with nothing saying which depth study it belongs to.
        """
        by_root = {entry.root.number: entry.regions for entry in self._history_regions()}
        region = by_root[9][0]
        self.assertLess(region.bbox[1], 128.0)

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
