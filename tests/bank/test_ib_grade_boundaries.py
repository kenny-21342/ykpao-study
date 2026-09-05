"""The IB grade-boundary parser, over its awkward cases.

Every case here is a shape found in the 26 real coordinator PDFs, not an
invented one: the 2018-2020 documents split every digit into its own glyph run,
History HL is examined by region so one subject-level carries four different
boundaries, and most subjects publish three timezones where the schema stores
one.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from parse_ib_grade_boundaries import parse_text, pick_option, pick_timezone  # noqa: E402


def block(subject, level, timezone, sevens, option=None, spaced=False):
    """One subject block ending in a FINAL table, as pdf text extraction yields it."""
    # Grade lows spread evenly up to the grade 7 cut, which is the number the
    # assertions care about.
    lows = [round(sevens * i / 6) for i in range(7)]
    rows = []
    for grade in range(1, 8):
        low = lows[grade - 1]
        high = lows[grade] - 1 if grade < 7 else 100
        rows.append(f"{grade}\n{low}\n{high}")
    table = "\n".join(rows)
    if spaced:
        table = "\n".join(" ".join(line) if line.isdigit() else line for line in table.split("\n"))
    return (
        f"  Subject:\xa0{subject}\xa0\xa0\xa0\n"
        f"  Level:\xa0{level}\xa0\xa0\xa0\n"
        f"  Subject\xa0option:\xa0{option or subject}\xa0\xa0\xa0\n"
        f"  Timezone:\xa0{timezone}\n"
        "PAPER ONE\nGrade\nFrom \n To  \n1\n0\n4\n2\n5\n8\n3\n9\n11\n4\n12\n16\n5\n17\n20\n6\n21\n25\n7\n26\n40\n"
        " FINAL \nGrade\nFrom \n To  \n" + table + "\n"
    )


class ParseTests(unittest.TestCase):
    def parse(self, text):
        rows, _ = parse_text(text, "May", 2025)
        return rows

    def test_reads_a_final_block_and_ignores_the_component_above_it(self):
        rows = self.parse(block("BIOLOGY", "HL", 3, 77))
        self.assertEqual(len(rows), 7)
        self.assertEqual(rows[-1]["minMark"], 77)
        self.assertEqual(rows[-1]["grade"], "7")
        # The whole ladder is FINAL's, not the component table printed above it.
        self.assertEqual([row["minMark"] for row in rows], [0, 13, 26, 38, 51, 64, 77])

    def test_every_row_is_out_of_one_hundred(self):
        rows = self.parse(block("PHYSICS", "SL", 0, 70))
        self.assertTrue(all(row["totalMarks"] == 100 for row in rows))

    def test_digits_split_across_glyph_runs_are_rejoined(self):
        """The 2018-2020 documents render 15 as "1 5"."""
        rows = self.parse(block("CHEMISTRY", "HL", 1, 84, spaced=True))
        self.assertEqual(rows[-1]["minMark"], 84)
        self.assertEqual([row["minMark"] for row in rows][:2], [0, 14])

    def test_a_subject_the_school_does_not_teach_is_skipped(self):
        rows, untaught = parse_text(block("LATIN", "HL", 0, 75), "May", 2025)
        self.assertEqual(rows, [])
        self.assertEqual(untaught, 1)

    def test_one_block_cannot_borrow_the_next_subjects_final(self):
        """A subject whose FINAL is missing must yield nothing, not its neighbour's."""
        truncated = block("BIOLOGY", "HL", 0, 77).split(" FINAL ")[0]
        rows = self.parse(truncated + block("PHYSICS", "HL", 0, 60))
        self.assertEqual({row["subjectCode"] for row in rows}, {"ib-physics"})

    def test_the_session_comes_from_the_filename_not_the_block(self):
        rows, _ = parse_text(block("GEOGRAPHY", "SL", 0, 72), "November", 2023)
        self.assertEqual({(r["session"], r["year"]) for r in rows}, {("November", 2023)})


class TimezoneTests(unittest.TestCase):
    def parse(self, *blocks):
        rows, _ = parse_text("".join(blocks), "May", 2025)
        return rows

    def test_a_subject_with_no_timezone_variant_is_kept_whole(self):
        kept = pick_timezone(self.parse(block("MUSIC", "SL", 0, 80)), 3)
        self.assertEqual(len(kept), 7)

    def test_the_preferred_timezone_wins_over_the_others(self):
        rows = self.parse(*(block("BIOLOGY", "HL", tz, 70 + tz) for tz in (1, 2, 3)))
        kept = pick_timezone(rows, 3)
        self.assertEqual(len(kept), 7)
        self.assertEqual(kept[-1]["minMark"], 73)

    def test_boundaries_are_never_averaged_across_timezones(self):
        """Averaging two real boundaries invents a number the IB never issued."""
        rows = self.parse(*(block("PHYSICS", "SL", tz, 60 + tz * 10) for tz in (1, 2)))
        kept = pick_timezone(rows, 3)
        self.assertIn(kept[-1]["minMark"], (70, 80))

    def test_falls_back_to_the_lowest_timezone_when_the_preferred_is_absent(self):
        rows = self.parse(*(block("HISTORY", "SL", tz, 60 + tz) for tz in (1, 2)))
        kept = pick_timezone(rows, 3)
        self.assertEqual(kept[-1]["minMark"], 61)


class OptionTests(unittest.TestCase):
    def parse(self, *blocks):
        rows, _ = parse_text("".join(blocks), "May", 2025)
        return rows

    def test_the_plain_option_is_taken_over_a_pilot_variant(self):
        rows = self.parse(
            block("ECONOMICS", "SL", 0, 76),
            block("ECONOMICS", "SL", 0, 77, option="ECONOMICS P11"),
        )
        kept, _ = pick_option(rows)
        self.assertEqual(len(kept), 7)
        self.assertEqual(kept[-1]["minMark"], 76)

    def test_regional_options_are_reported_when_they_disagree(self):
        rows = self.parse(
            block("HISTORY", "HL", 0, 74, option="HISTORY EUROPE"),
            block("HISTORY", "HL", 0, 73, option="HISTORY ASIA AND OCEANIA"),
        )
        kept, notes = pick_option(rows)
        self.assertEqual(len(kept), 7)
        self.assertEqual(len(notes), 1)
        self.assertIn("HISTORY ASIA AND OCEANIA", notes[0])

    def test_identical_options_raise_no_note(self):
        rows = self.parse(
            block("HISTORY", "HL", 0, 74, option="HISTORY EUROPE"),
            block("HISTORY", "HL", 0, 74, option="HISTORY AMERICAS"),
        )
        kept, notes = pick_option(rows)
        self.assertEqual(notes, [])
        self.assertEqual(len(kept), 7)


if __name__ == "__main__":
    unittest.main()
