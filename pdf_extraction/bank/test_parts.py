"""Run with: python3 -m unittest pdf_extraction.bank.test_parts"""
import json
import unittest

from .parts import parts_for_question, segment
from .tag_parts import build_user_text, parse_response


class SegmentTests(unittest.TestCase):
    def test_letters_and_romans(self):
        body = "**(a)**\nx\n\n**(b)**\ny\n\n**(i)**\nz\n\n**(ii)**\nw [2]"
        self.assertEqual([p["label"] for p in segment(body)], ["a", "b(i)", "b(ii)"])

    def test_compound_marker_and_container(self):
        body = "**(a)**\nintro\n**(a)(i)**\nq [1]\n**(a)(ii)**\nq [2]\n**(b)**\nlast [3]"
        parts = segment(body)
        self.assertEqual([p["label"] for p in parts], ["a(i)", "a(ii)", "b"])
        self.assertEqual([p["marks"] for p in parts], [1, 2, 3])

    def test_i_after_h_is_a_letter(self):
        body = "**(g)**\na\n**(h)**\nb\n**(i)**\nc"
        self.assertEqual([p["label"] for p in segment(body)], ["g", "h", "i"])

    def test_no_markers_means_no_parts(self):
        self.assertEqual(segment("Just a stem with no parts."), [])


class PartsForQuestionTests(unittest.TestCase):
    def test_stored_parts_win_and_keep_marks(self):
        stored = json.dumps([{"label": "a", "marks": 2}, {"label": "b", "marks": 3}])
        got = parts_for_question(stored, "**(a)**\nx\n**(b)**\ny\n**(c)**\nz")
        self.assertEqual(got, [{"label": "a", "marks": 2}, {"label": "b", "marks": 3}])

    def test_falls_back_to_the_text_when_nothing_is_stored(self):
        got = parts_for_question("[]", "**(a)**\nx [1]\n**(b)**\ny [2]")
        self.assertEqual([p["label"] for p in got], ["a", "b"])

    def test_one_part_is_a_single_part_question(self):
        self.assertEqual(parts_for_question(json.dumps([{"label": "a", "marks": 3}]), "plain"), [])

    def test_bad_json_is_tolerated(self):
        self.assertEqual(parts_for_question("not json", "plain"), [])


class ParseResponseTests(unittest.TestCase):
    parts = [{"label": "a", "marks": 1}, {"label": "b", "marks": 3}]

    def test_only_licensed_labels_topics_and_difficulties_survive(self):
        content = {"parts": [
            {"label": "a", "topic": "mechanics", "difficulty": 9, "rationale": "r"},
            {"label": "z", "topic": "Mechanics", "difficulty": 2},
            {"label": "b", "topic": "Invented", "difficulty": "3"},
        ]}
        got = parse_response(content, self.parts, ["Mechanics"])
        self.assertEqual([g["label"] for g in got], ["a", "b"])
        self.assertEqual(got[0]["topic"], "Mechanics")   # case-insensitive match, canonical spelling
        self.assertEqual(got[0]["difficulty"], 5)         # clamped
        self.assertIsNone(got[1]["topic"])                # not on the list
        self.assertEqual(got[1]["marks"], 3)

    def test_prompt_carries_labels_and_marks(self):
        text = json.loads(build_user_text("stem", self.parts, ["T"], "Physics"))
        self.assertEqual(text["parts"], [{"label": "a", "marks": 1}, {"label": "b", "marks": 3}])


if __name__ == "__main__":
    unittest.main()
