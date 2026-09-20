"""Recovering a refused transcript from the PDF's own text layer.

The vision model will not transcribe copyrighted literary material, and it
says so in a 200 OK. No amount of retrying changes that -- the refusal is the
model working as intended -- so the only way back is to stop asking a model.
The source PDFs carry a real text layer and the store already knows the exact
rectangle each question was cropped from, which is enough.
"""

from __future__ import annotations

import unittest

from pdf_extraction.bank.recover_text_layer import clean, verdict


class CleanTests(unittest.TestCase):
    def test_page_furniture_is_stripped(self) -> None:
        """Every clip picks these up; none of them is ever part of a question."""
        raw = (
            "7\n"
            "0475/12/F/M/25\n"
            "© UCLES 2025\n"
            "[Turn over\n"
            "4 In what ways does Jennings create a sense of mystery?\n"
        )
        self.assertEqual(
            clean(raw),
            "4 In what ways does Jennings create a sense of mystery?",
        )

    def test_a_mark_scheme_page_header_is_stripped(self) -> None:
        self.assertEqual(clean("Page 9 of 11\nQuestion\nAnswer"), "Question\nAnswer")

    def test_question_numbers_in_the_body_survive(self) -> None:
        """The bare-number rule targets the page number on its own line.

        Poem line numbers sit on their own line too, and a question that opens
        with its own number must not lose it -- so the rule is only allowed to
        eat lines that are nothing but a number, and the surrounding text has
        to come through untouched.
        """
        kept = clean("4 (a) State the charge on an electron.\nAnswer in coulombs.")
        self.assertEqual(kept, "4 (a) State the charge on an electron.\nAnswer in coulombs.")


class VerdictTests(unittest.TestCase):
    def test_a_full_passage_is_recovered(self) -> None:
        self.assertEqual(verdict("In what ways does Jennings create a sense of " * 3), "recovered")

    def test_cies_own_redaction_is_not_recoverable(self) -> None:
        """Nine of the 34 read like this in the published paper itself.

        There is no technique that recovers these, so they must be recognised
        rather than stored: a half-passage ending in the redaction notice is
        exactly the wrong thing to mark a student against.
        """
        raw = (
            "Either 1 (a) Read this passage carefully:\n"
            "Mama [collecting herself]: Well ... I don't know what we all so excited about.\n"
            "Content removed due to copyright restrictions.\n"
        )
        self.assertEqual(verdict(raw), "redacted")

    def test_an_empty_clip_is_not_passed_off_as_a_transcript(self) -> None:
        self.assertEqual(verdict("   \n  "), "thin")


if __name__ == "__main__":
    unittest.main()
