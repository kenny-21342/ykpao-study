"""The syllabus topic registry, and the reason it exists.

Stage 4 whitelists topics against a supplied syllabus list and drops anything
else. Nothing in the production path supplied one, so the tagging pass wrote
zero topics for the entire corpus while being billed for every question.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from pdf_extraction.bank import topics as topics_module
from pdf_extraction.bank.tag import _parse_tagging_response


class RegistryTests(unittest.TestCase):
    def _registry(self, payload: dict) -> Path:
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "syllabus_topics.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_a_configured_subject_returns_its_topics_and_context(self) -> None:
        path = self._registry({"9709": {"context": "CAIE 9709", "topics": ["Vectors"]}})
        with mock.patch.object(topics_module, "_REGISTRY", path):
            self.assertEqual(topics_module.topics_for("9709"), (["Vectors"], "CAIE 9709"))

    def test_an_unknown_subject_returns_none_rather_than_an_empty_list(self) -> None:
        """The runner has to tell "not configured" from "genuinely none"."""
        path = self._registry({"9709": {"topics": ["Vectors"]}})
        with mock.patch.object(topics_module, "_REGISTRY", path):
            self.assertIsNone(topics_module.topics_for("0625"))

    def test_a_configured_subject_with_no_topics_is_also_none(self) -> None:
        path = self._registry({"0625": {"topics": []}})
        with mock.patch.object(topics_module, "_REGISTRY", path):
            self.assertIsNone(topics_module.topics_for("0625"))

    def test_separators_and_case_do_not_matter(self) -> None:
        path = self._registry({"Sports exercise": {"topics": ["Anatomy"]}})
        with mock.patch.object(topics_module, "_REGISTRY", path):
            self.assertIsNotNone(topics_module.topics_for("sports-exercise"))
            self.assertIsNotNone(topics_module.topics_for("SPORTS_EXERCISE"))

    def test_a_missing_registry_is_not_an_error(self) -> None:
        with mock.patch.object(topics_module, "_REGISTRY", Path("/nonexistent.json")):
            self.assertIsNone(topics_module.topics_for("9709"))
            self.assertEqual(topics_module.configured_subjects(), [])

    def test_the_shipped_registry_parses(self) -> None:
        """It is loaded at run time, so a syntax error would surface mid-run."""
        for subject in topics_module.configured_subjects():
            found = topics_module.topics_for(subject)
            self.assertIsNotNone(found, subject)
            self.assertTrue(found[0], subject)


class WhitelistTests(unittest.TestCase):
    """Why an unconfigured subject must not be tagged."""

    REPLY = {"topics": ["Vectors"], "tags": ["dot-product"], "skills": [],
             "difficulty": 3, "difficulty_rationale": "", "confidence": 0.9}

    def test_topics_survive_when_the_syllabus_lists_them(self) -> None:
        result = _parse_tagging_response(
            self.REPLY, allowed_topics=["Vectors"], source_text="Find the vector.")
        self.assertEqual(result.topics, ["Vectors"])

    def test_every_topic_is_discarded_when_no_syllabus_is_supplied(self) -> None:
        # The corpus-wide defect: billed per question, zero topics written.
        result = _parse_tagging_response(
            self.REPLY, allowed_topics=[], source_text="Find the vector.")
        self.assertEqual(result.topics, [])
        # Tags and difficulty still come back, which is why the run looked fine.
        self.assertEqual(result.tags, ["dot-product"])
        self.assertEqual(result.difficulty, 3)


if __name__ == "__main__":
    unittest.main()
