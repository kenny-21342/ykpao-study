"""Era- and level-aware syllabus topic lists."""
import unittest

from .topics import syllabus_for, topics_for


class SyllabusFor(unittest.TestCase):
    def test_physics_before_2025_uses_the_2016_list(self):
        found = syllabus_for("physics", 2023, "HL")
        self.assertEqual(found.variant, "")
        self.assertIn("Mechanics", found.topics)
        self.assertNotIn("A.1 Kinematics", found.topics)

    def test_physics_from_2025_uses_the_new_themes(self):
        found = syllabus_for("physics", 2025, "HL")
        self.assertEqual(found.variant, "era2025")
        self.assertEqual(len(found.topics), 24)
        self.assertIn("A.4 Rigid body mechanics", found.topics)
        self.assertNotIn("Mechanics", found.topics)

    def test_sl_never_gets_hl_only_topics(self):
        old = syllabus_for("physics", 2019, "SL")
        self.assertNotIn("Wave phenomena", old.topics)
        self.assertNotIn("Fields", old.topics)
        self.assertIn("Waves", old.topics)
        new = syllabus_for("physics", 2025, "SL")
        for hl_only in ("A.4 Rigid body mechanics", "A.5 Galilean and special relativity",
                        "B.4 Thermodynamics", "D.4 Induction", "E.2 Quantum physics"):
            self.assertNotIn(hl_only, new.topics)
        self.assertEqual(new.variant, "era2025-SL")

    def test_combined_level_keeps_everything(self):
        self.assertEqual(len(syllabus_for("physics", 2025, "HLSL").topics), 24)

    def test_year_and_level_are_optional_and_other_subjects_are_unchanged(self):
        self.assertEqual(syllabus_for("physics").topics, topics_for("physics")[0])
        self.assertEqual(syllabus_for("0625", 2022, "").topics, topics_for("0625")[0])
        self.assertIsNone(syllabus_for("no-such-subject", 2025, "HL"))


if __name__ == "__main__":
    unittest.main()
