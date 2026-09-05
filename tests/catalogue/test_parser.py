from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pdf_extraction"))

from catalogue.parser import ParseError, is_indexable_audio, parse_path  # noqa: E402

ROOT = Path(".")
IB_2023_NOV = Path(
    "IB PAST PAPERS - YEAR/2023 Examination Session/"
    "November 2023 Examination Session/Experimental sciences"
)
IB_2025_MAY = Path(
    "IB PAST PAPERS - YEAR/2025 Examination Session/"
    "May 2025 Examination Session/Experimental sciences"
)


class CaiePathTests(unittest.TestCase):
    def test_splits_component_into_paper_and_variant(self) -> None:
        entry = parse_path(Path("my_raw_pdfs/a-level/mathematics-9709/9709_s20_qp_52.pdf"), ROOT)
        self.assertEqual(entry.board, "CAIE")
        self.assertEqual(entry.qualification, "A Level")
        self.assertEqual(entry.subject_code, "9709")
        # The shared table calls this "Mathematics A-Level"; the level lives in
        # its own column, so the display name drops the suffix.
        self.assertEqual(entry.subject_name, "Mathematics")
        self.assertEqual(entry.year, 2020)
        self.assertEqual(entry.session, "s")
        self.assertEqual(entry.paper_number, 5)
        self.assertEqual(entry.variant, 2)
        self.assertEqual(entry.doc_type, "qp")
        self.assertEqual(entry.level, "")

    def test_qualification_comes_from_code_prefix(self) -> None:
        igcse = parse_path(Path("my_raw_pdfs/igcse/physics-0625/0625_w21_ms_63.pdf"), ROOT)
        self.assertEqual(igcse.qualification, "IGCSE")
        self.assertEqual(igcse.session, "w")
        self.assertEqual(igcse.doc_type, "ms")

    def test_march_series_and_insert_document(self) -> None:
        entry = parse_path(Path("my_raw_pdfs/igcse/biology-0610/0610_m18_in_12.pdf"), ROOT)
        self.assertEqual(entry.session, "m")
        self.assertEqual(entry.doc_type, "in")

    def test_bare_paper_number_without_variant(self) -> None:
        entry = parse_path(Path("my_raw_pdfs/igcse/history-0470/0470_s15_qp_1.pdf"), ROOT)
        self.assertEqual(entry.paper_number, 1)
        self.assertEqual(entry.variant, 0)

    def test_filepath_is_relative_to_root(self) -> None:
        path = Path("my_raw_pdfs/igcse/physics-0625/0625_w21_qp_63.pdf")
        self.assertEqual(parse_path(path, ROOT).filepath, path.as_posix())

    def test_question_paper_and_mark_scheme_share_an_instance_key(self) -> None:
        qp = parse_path(Path("my_raw_pdfs/a-level/mathematics-9709/9709_s20_qp_52.pdf"), ROOT)
        ms = parse_path(Path("my_raw_pdfs/a-level/mathematics-9709/9709_s20_ms_52.pdf"), ROOT)
        self.assertEqual(qp.instance_key, ms.instance_key)
        self.assertNotEqual(qp.doc_type, ms.doc_type)

    def test_different_variants_are_different_instances(self) -> None:
        v1 = parse_path(Path("my_raw_pdfs/a-level/mathematics-9709/9709_s20_qp_51.pdf"), ROOT)
        v2 = parse_path(Path("my_raw_pdfs/a-level/mathematics-9709/9709_s20_qp_52.pdf"), ROOT)
        self.assertNotEqual(v1.instance_key, v2.instance_key)


class IbPathTests(unittest.TestCase):
    def test_year_and_session_come_from_the_directory(self) -> None:
        entry = parse_path(IB_2023_NOV / "Biology_paper_2__TZ1_HL_markscheme.pdf", ROOT)
        self.assertEqual(entry.board, "IB")
        self.assertEqual(entry.qualification, "Diploma Programme")
        self.assertEqual(entry.year, 2023)
        self.assertEqual(entry.session, "nov")
        self.assertEqual(entry.level, "HL")
        self.assertEqual(entry.timezone, "TZ1")
        self.assertEqual(entry.doc_type, "ms")

    def test_november_is_not_shadowed_by_the_parent_year_directory(self) -> None:
        # The November folder nests inside "2023 Examination Session", so a
        # naive "may" check would mislabel every November paper.
        entry = parse_path(IB_2023_NOV / "Biology_paper_1__TZ2_SL.pdf", ROOT)
        self.assertEqual(entry.session, "nov")

    def test_lettered_paper_keeps_its_code_and_numeric_sort(self) -> None:
        entry = parse_path(IB_2025_MAY / "Biology_paper_1A_TZ1_HL.pdf", ROOT)
        self.assertEqual(entry.paper_number, 1)
        self.assertEqual(entry.paper_code, "1A")

    def test_hlsl_is_matched_before_hl_and_sl(self) -> None:
        entry = parse_path(IB_2023_NOV / "Philosophy_paper_2__HLSL_markscheme.pdf", ROOT)
        self.assertEqual(entry.level, "HLSL")

    def test_multiword_subject_becomes_a_slug(self) -> None:
        entry = parse_path(
            IB_2023_NOV / "Mathematics_analysis_and_approaches_paper_1__TZ1_HL.pdf", ROOT
        )
        self.assertEqual(entry.subject_code, "ib-mathematics-analysis-and-approaches")
        self.assertEqual(entry.subject_name, "Mathematics Analysis and Approaches")

    def test_acronym_subjects_are_not_title_cased(self) -> None:
        entry = parse_path(IB_2023_NOV / "ITGS_paper_1__HL_markscheme.pdf", ROOT)
        self.assertEqual(entry.subject_name, "ITGS")

    def test_booklet_document_types(self) -> None:
        cases = {
            "Geography_paper_2__resource_booklet_HLSL.pdf": "rb",
            "History_paper_1__question_booklet_HLSL.pdf": "qb",
            "History_paper_1__text_booklet_HLSL.pdf": "tb",
            "Business_management_paper_1__case_study_HLSL.pdf": "cs",
        }
        for filename, expected in cases.items():
            with self.subTest(filename=filename):
                self.assertEqual(parse_path(IB_2023_NOV / filename, ROOT).doc_type, expected)

    def test_music_is_filed_without_a_paper_token(self) -> None:
        arts = Path(
            "IB PAST PAPERS - YEAR/2016 Examination Session/"
            "May 2016 Examination Session/The arts"
        )
        listening = parse_path(arts / "Music___listening_paper_HL.pdf", ROOT)
        # The audio ships as separate mp3 tracks, so the PDF is the paper itself.
        self.assertEqual(listening.doc_type, "qp")
        self.assertEqual(listening.subject_code, "ib-music")
        scheme = parse_path(arts / "Music___HLSL_markscheme.pdf", ROOT)
        self.assertEqual(scheme.doc_type, "ms")
        booklet = parse_path(arts / "Music___score_booklet_HLSL.pdf", ROOT)
        self.assertEqual(booklet.doc_type, "rb")

    def test_hl_and_sl_of_the_same_paper_are_distinct_instances(self) -> None:
        hl = parse_path(IB_2023_NOV / "Biology_paper_1__TZ1_HL.pdf", ROOT)
        sl = parse_path(IB_2023_NOV / "Biology_paper_1__TZ1_SL.pdf", ROOT)
        self.assertNotEqual(hl.instance_key, sl.instance_key)

    def test_timezones_are_distinct_instances(self) -> None:
        tz1 = parse_path(IB_2023_NOV / "Biology_paper_1__TZ1_HL.pdf", ROOT)
        tz2 = parse_path(IB_2023_NOV / "Biology_paper_1__TZ2_HL.pdf", ROOT)
        self.assertNotEqual(tz1.instance_key, tz2.instance_key)


class RejectionTests(unittest.TestCase):
    def test_unparseable_filename_raises(self) -> None:
        with self.assertRaises(ParseError):
            parse_path(Path("IB PAST PAPERS - YEAR/2023 Examination Session/notes.pdf"), ROOT)

    def test_ib_path_without_a_session_raises(self) -> None:
        with self.assertRaises(ParseError):
            parse_path(Path("IB PAST PAPERS - YEAR/2023 Session/Biology_paper_1__HL.pdf"), ROOT)


if __name__ == "__main__":
    unittest.main()


class ListeningAudioTests(unittest.TestCase):
    """Music listening tracks, which ship beside the PDFs as loose mp3s.

    A tester who studies Music opened a listening paper and found no audio: the
    tracks were on disk all along, and the indexer walked only `*.pdf`.
    """

    AUDIO = Path(
        "IB PAST PAPERS - YEAR/2019 Examination Session/"
        "May 2019 Examination Session/audio"
    )

    def test_a_track_is_placed_against_its_sitting(self) -> None:
        entry = parse_path(self.AUDIO / "Track 3.mp3", ROOT)
        self.assertEqual(entry.subject_code, "ib-music")
        self.assertEqual(entry.doc_type, "au")
        self.assertEqual((entry.year, entry.session), (2019, "may"))
        self.assertEqual(entry.paper_number, 1)
        self.assertEqual(entry.filename, "Track 3.mp3")

    def test_tracks_join_the_sitting_rather_than_splitting_it(self) -> None:
        """Four tracks must share one instance key, not make four sittings."""
        keys = {
            (e.subject_code, e.year, e.session, e.paper_number, e.variant, e.level, e.timezone)
            for e in (parse_path(self.AUDIO / f"Track {n}.mp3", ROOT) for n in range(1, 5))
        }
        self.assertEqual(len(keys), 1)

    def test_level_covers_both_cohorts(self) -> None:
        """One recording is played to HL and SL alike."""
        self.assertEqual(parse_path(self.AUDIO / "Track 1.mp3", ROOT).level, "HLSL")

    def test_language_recordings_are_left_unindexed(self) -> None:
        """The same directories hold coded language B tracks for untaught
        subjects; guessing a subject from those names would file them wrong."""
        self.assertFalse(is_indexable_audio(self.AUDIO / "m19abengsliengtz0xxl.mp3"))
        self.assertTrue(is_indexable_audio(self.AUDIO / "Track 2.mp3"))

    def test_an_unplaceable_track_is_a_parse_error_not_a_guess(self) -> None:
        with self.assertRaises(ParseError):
            parse_path(self.AUDIO / "m19abengsliengtz0xxl.mp3", ROOT)

    def test_a_track_outside_a_session_directory_is_rejected(self) -> None:
        with self.assertRaises(ParseError):
            parse_path(Path("IB PAST PAPERS - YEAR/audio/Track 1.mp3"), ROOT)
