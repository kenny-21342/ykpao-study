"""The collapse detector has to judge a transcript against its own kind.

Its first version averaged the length of the last 400 transcripts and
compared that to a fixed floor. It raised four alarms in one day, every one
of them on healthy output: the run had reached the multiple-choice papers,
where a whole question is "How many protons are there in one nucleus?".

That is the failure mode that matters for a monitor. A detector that fires on
good data trains you to skim past it, so by the time it is right nobody is
reading. These tests pin the two halves of being useful: silent on an
MCQ-heavy run, loud when the model actually degrades.
"""

from __future__ import annotations

import sqlite3
import unittest

from pdf_extraction.bank import store, watch_quality

MODEL = "gpt-5.6-sol"


class CollapseDetectorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.executescript(store.SCHEMA_PATH.read_text(encoding="utf-8"))
        self.addCleanup(self.conn.close)
        self.subject = store.upsert_subject(
            self.conn, board="CAIE", code="0625", name="Physics", level="igcse")

    def _paper(self, paper_number: int, variant: int) -> int:
        return store.upsert_paper(
            self.conn,
            subject_id=self.subject,
            identity=store.PaperIdentity(
                code="0625", board="CAIE", year=2023, session="s",
                paper_number=paper_number, variant=variant, doc_type="qp"),
            source_path=f"/corpus/0625_p{paper_number}_v{variant}.pdf",
            source_sha256=f"{paper_number}{variant}".ljust(64, "0"),
            page_count=12, span_strategy="prose", used_ocr=False,
        )

    def _questions(self, paper_id: int, count: int, length: int, start_root: int = 1) -> list[int]:
        ids = []
        for n in range(count):
            cur = self.conn.execute(
                "INSERT INTO bank_questions (paper_id, root_number, body_md, status, model) "
                "VALUES (?, ?, ?, 'published', ?)",
                (paper_id, start_root + n, "x" * length, MODEL))
            ids.append(cur.lastrowid)
        return ids

    def _collapsing(self, recent_ids: list[int]) -> list[dict]:
        self.conn.commit()
        return watch_quality.collapsing_groups(self.conn, MODEL, recent_ids)

    def test_a_run_of_multiple_choice_papers_is_not_a_collapse(self) -> None:
        """The false alarm that prompted this. MCQ questions are just short."""
        peers = self._paper(1, 1)
        self._questions(peers, 40, 130)
        recent_paper = self._paper(1, 2)
        recent = self._questions(recent_paper, 40, 125)

        self.assertEqual(self._collapsing(recent), [])

    def test_a_genuine_collapse_on_the_same_kind_of_paper_is_caught(self) -> None:
        """The alarm worth keeping: same paper number, a fifth of the length."""
        peers = self._paper(4, 1)
        self._questions(peers, 40, 800)
        recent_paper = self._paper(4, 2)
        recent = self._questions(recent_paper, 40, 120)

        found = self._collapsing(recent)
        self.assertEqual(len(found), 1)
        self.assertIn("0625 paper 4", found[0]["label"])

    def test_short_papers_do_not_mask_a_collapse_elsewhere(self) -> None:
        """The specific thing a flat average got wrong.

        An MCQ paper and a collapsed structured paper in the same window used
        to average out. Judged per group, the MCQ half stays silent and the
        structured half still trips.
        """
        self._questions(self._paper(1, 1), 40, 130)
        self._questions(self._paper(4, 1), 40, 800)
        recent = self._questions(self._paper(1, 2), 40, 128)
        recent += self._questions(self._paper(4, 2), 40, 90)

        found = self._collapsing(recent)
        self.assertEqual([g["label"] for g in found], ["0625 paper 4"])

    def test_a_subject_with_no_peers_falls_back_to_the_absolute_floor(self) -> None:
        """First transcription of a subject has nothing to compare against."""
        recent = self._questions(self._paper(6, 1), 40, 30)
        found = self._collapsing(recent)
        self.assertEqual(len(found), 1)
        self.assertIn("no peers yet", found[0]["label"])

    def test_a_first_look_at_a_subject_that_is_fine_stays_quiet(self) -> None:
        recent = self._questions(self._paper(6, 1), 40, 600)
        self.assertEqual(self._collapsing(recent), [])

    def test_the_baseline_excludes_the_rows_being_judged(self) -> None:
        """Otherwise a big enough collapse drags its own baseline down.

        Here every transcript for this paper number is collapsed, so a
        baseline that included them would find the recent rows perfectly
        normal and say nothing -- the total-failure case going unreported.
        """
        peers = self._paper(2, 1)
        self._questions(peers, 30, 700)
        recent = self._questions(self._paper(2, 2), 60, 80)

        found = self._collapsing(recent)
        self.assertEqual(len(found), 1)
        self.assertLess(found[0]["recent"], found[0]["baseline"])

    def test_a_group_too_small_to_judge_is_left_alone(self) -> None:
        """Below MIN_SAMPLE, a short average is noise rather than a trend."""
        self._questions(self._paper(4, 1), 40, 800)
        recent = self._questions(self._paper(4, 2), watch_quality.MIN_SAMPLE - 1, 50)
        self.assertEqual(self._collapsing(recent), [])


if __name__ == "__main__":
    unittest.main()
