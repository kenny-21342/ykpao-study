"""Subject selection for --subject runs.

Every case here is a real corpus path. The bug these guard against is silent:
a subject that matches nothing reports "0 documents" and the driver moves on,
so a re-render can skip a sixth of the corpus and still look like it worked.
"""
from pathlib import Path

import pytest

from pdf_extraction.bank.corpus_run import matches_subject

IB = Path("pdf_extraction/IB PAST PAPERS - YEAR/2021 Examination Session/"
          "November 2021 Examination Session/Group 5 - Mathematics")
IB_HUM = Path("pdf_extraction/IB PAST PAPERS - YEAR/2021 Examination Session/"
              "November 2021 Examination Session/Individuals and societies")
CAIE = Path("pdf_extraction/my_raw_pdfs/igcse/physics-0625")


@pytest.mark.parametrize("subject,name", [
    ("business-management", "Business_management_paper_1__HL.pdf"),
    ("computer-science", "Computer_science_paper_2__HL.pdf"),
    ("sports-exercise-and-health-science",
     "Sports_exercise_and_health_science_paper_1__SL.pdf"),
    ("mathematics-analysis-and-approaches",
     "Mathematics_analysis_and_approaches_paper_1__HL.pdf"),
    ("english-a-language-and-literature",
     "English_A_Language_and_literature_paper_2__SL.pdf"),
    ("history-route-2", "History_route_2_paper_1__HLSL.pdf"),
])
def test_hyphenated_subject_matches_underscored_filename(subject, name):
    """The slugs use hyphens and the IB filenames use underscores.

    Matching them literally returned nothing for every multi-word subject
    while single-word ones worked, which is why this looked like missing
    papers rather than a bug.
    """
    assert matches_subject(IB_HUM / name, subject)


def test_mathematics_does_not_swallow_its_siblings():
    """`Group 5 - Mathematics` ends with `-mathematics`.

    Deciding on the directory first therefore handed every maths subject to
    `mathematics`: 602 papers where 176 belong.
    """
    assert matches_subject(IB / "Mathematics_paper_1__HL.pdf", "mathematics")
    for other in ("Mathematics_analysis_and_approaches_paper_1__HL.pdf",
                  "Mathematics_applications_and_interpretation_paper_2__SL.pdf",
                  "Mathematical_studies_paper_1__SL.pdf",
                  "Further_mathematics_paper_1__HL.pdf"):
        assert not matches_subject(IB / other, "mathematics"), other


def test_history_does_not_swallow_its_routes():
    assert matches_subject(IB_HUM / "History_paper_2__HLSL.pdf", "history")
    assert not matches_subject(
        IB_HUM / "History_route_2_paper_1__HLSL.pdf", "history")


def test_caie_still_matches_by_code():
    """CAIE filenames carry no paper marker, so they keep the prefix test."""
    assert matches_subject(CAIE / "0625_s23_qp_41.pdf", "0625")
    assert matches_subject(CAIE / "0625_s23_ms_41.pdf", "0625")
    assert not matches_subject(CAIE / "0625_s23_qp_41.pdf", "0620")


def test_caie_matches_by_directory_code():
    assert matches_subject(CAIE / "anything.pdf", "0625")


def test_music_files_without_a_paper_marker_still_match():
    arts = Path("pdf_extraction/IB PAST PAPERS - YEAR/2021 Examination "
                "Session/Group 6 - The Arts")
    assert matches_subject(arts / "Music___score_booklet_HLSL.pdf", "music")
    assert matches_subject(arts / "Music___SL_markscheme.pdf", "music")
