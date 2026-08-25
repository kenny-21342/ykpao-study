"""Figure-citation QA.

Regression cover for the defect found by running the pipeline against
0620_s23_qp_41: all three of question 3's figure citations pointed at the
wrong crop, at 0.95 confidence, with every other QA check passing.
"""
from __future__ import annotations

import unittest

from pdf_extraction.bank.qa import (
    ISSUE_FIGURE_CITATION_OFFSET,
    ISSUE_FIGURE_CITATION_ORDER,
    ISSUE_FIGURE_UNCITED,
    SEVERITY_HIGH,
    run_qa_checks,
)
from pdf_extraction.bank.transcribe import QuestionTranscription


def question(body: str, figures: list[str]) -> QuestionTranscription:
    return QuestionTranscription(
        root_number=3,
        body_md=body,
        parts=[{"label": "a", "marks": 3}],
        total_marks=3,
        figures_used=figures,
        has_table=False,
        confidence=0.95,
        notes="",
    )


# Page 4 held three figures; page 5 held a table.
INVENTORY = [
    {"id": "fig1", "page": 4, "kind": "figure"},
    {"id": "fig2", "page": 4, "kind": "table"},
    {"id": "fig3", "page": 4, "kind": "figure"},
    {"id": "fig4", "page": 5, "kind": "table"},
]

GOOD_BODY = (
    "Configurations are shown in Fig. 3.1.\n\n![](asset:fig1)\n\n"
    "Complete Fig. 3.2.\n\n![](asset:fig2)\n\n"
    "Complete Fig. 3.3.\n\n![](asset:fig3)\n"
)

# What the pipeline actually produced before the renderer was fixed.
OFFSET_BODY = (
    "Configurations are shown in Fig. 3.1.\n\n![](asset:fig2)\n\n"
    "Complete Fig. 3.2.\n\n![](asset:fig3)\n\n"
    "Complete Fig. 3.3.\n\n![](asset:fig4)\n"
)


def issue_types(flags) -> set[str]:
    return {flag.issue_type for flag in flags}


class FigureCitationTests(unittest.TestCase):
    def test_correct_citations_raise_nothing(self):
        flags = run_qa_checks(question(GOOD_BODY, ["fig1", "fig2", "fig3"]), 1, None,
                              figure_inventory=INVENTORY)
        self.assertEqual(issue_types(flags), set(), [f.message for f in flags])

    def test_the_real_off_by_one_is_caught(self):
        flags = run_qa_checks(question(OFFSET_BODY, ["fig2", "fig3", "fig4"]), 1, None,
                              figure_inventory=INVENTORY)
        self.assertIn(ISSUE_FIGURE_CITATION_OFFSET, issue_types(flags))
        offset = next(f for f in flags if f.issue_type == ISSUE_FIGURE_CITATION_OFFSET)
        self.assertEqual(offset.evidence["page"], 4)
        self.assertEqual(offset.evidence["cited"], ["fig2", "fig3"])

    def test_a_named_but_uncited_figure_is_high_severity(self):
        body = "Look at Fig. 3.1 and Fig. 3.2.\n\n![](asset:fig1)\n"
        flags = run_qa_checks(question(body, ["fig1"]), 1, None, figure_inventory=INVENTORY)
        self.assertIn(ISSUE_FIGURE_UNCITED, issue_types(flags))
        flag = next(f for f in flags if f.issue_type == ISSUE_FIGURE_UNCITED)
        self.assertEqual(flag.severity, SEVERITY_HIGH)
        self.assertEqual(flag.evidence["captions"], ["3.1", "3.2"])

    def test_citations_out_of_reading_order_are_caught(self):
        body = "Fig. 3.1\n\n![](asset:fig3)\n\nFig. 3.2\n\n![](asset:fig1)\n"
        flags = run_qa_checks(question(body, ["fig1", "fig3"]), 1, None,
                              figure_inventory=INVENTORY)
        self.assertIn(ISSUE_FIGURE_CITATION_ORDER, issue_types(flags))

    def test_a_skipped_spurious_figure_below_the_first_is_not_flagged(self):
        # Physics 0625 Q1: two candidates on the page, only the real one cited.
        # Citing the first and ignoring a later detection is normal.
        inventory = [{"id": "fig1", "page": 2, "kind": "figure"},
                     {"id": "fig2", "page": 2, "kind": "figure"}]
        body = "Fig. 1.1 shows a river.\n\n![](asset:fig1)\n"
        flags = run_qa_checks(question(body, ["fig1"]), 1, None, figure_inventory=inventory)
        self.assertEqual(issue_types(flags), set(), [f.message for f in flags])

    def test_a_question_with_no_figures_at_all_is_clean(self):
        flags = run_qa_checks(question("Calculate the mass.", []), 1, None, figure_inventory=[])
        self.assertEqual(issue_types(flags), set())

    def test_a_table_caption_does_not_demand_an_asset(self):
        # Tables are transcribed as HTML, not cited — requiring a citation
        # would flag correct work.
        body = "Melting points are in Table 3.1.\n\n<table><tr><td>x</td></tr></table>\n"
        flags = run_qa_checks(question(body, []), 1, None, figure_inventory=INVENTORY)
        self.assertEqual(issue_types(flags), set(), [f.message for f in flags])

    def test_the_checks_stay_off_when_no_inventory_is_given(self):
        flags = run_qa_checks(question(OFFSET_BODY, ["fig2"]), 1, None)
        self.assertEqual(issue_types(flags) & {
            ISSUE_FIGURE_UNCITED, ISSUE_FIGURE_CITATION_OFFSET, ISSUE_FIGURE_CITATION_ORDER
        }, set())


if __name__ == "__main__":
    unittest.main()
