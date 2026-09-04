"""The syllabus topic registry, and the reason it exists.

Stage 4 whitelists topics against a supplied syllabus list and drops anything
else. Nothing in the production path supplied one, so the tagging pass wrote
zero topics for the entire corpus while being billed for every question.
"""

from __future__ import annotations

import json
import re
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


class CoverageTests(unittest.TestCase):
    """Every subject the site publishes must have a syllabus list.

    This is the guard the original defect needed. `topics_for` returning None
    is not an error anywhere -- stage 4 simply whitelists against nothing and
    silently drops every topic the model returns, while still being billed per
    question. A subject added to `COURSE_CATALOG` and forgotten here would
    reproduce that exactly, one subject at a time instead of corpus-wide.

    The catalogue is TypeScript, so it is read as text. Both constructors take
    the subject code last, and IB codes carry an `ib-` prefix that the ingest
    pipeline drops when it writes `bank_subjects.code` -- so the prefix is
    stripped here too, and that stripping is the coupling being asserted.
    """

    CATALOG = (
        Path(__file__).resolve().parents[2] / "lib" / "course-catalog-data.ts"
    )

    def published_subject_codes(self) -> set[str]:
        source = self.CATALOG.read_text(encoding="utf-8")
        cambridge = re.findall(r"^\s*cambridge\(.*'([^']+)'\),\s*$", source, re.M)
        ib = re.findall(r"^\s*ib\(.*'ib-([^']+)'\),\s*$", source, re.M)
        return set(cambridge) | set(ib)

    def test_the_catalogue_is_readable_and_not_empty(self) -> None:
        """A regex that silently matched nothing would make this suite vacuous."""
        codes = self.published_subject_codes()
        self.assertGreater(len(codes), 30, "catalogue parse produced too few codes")
        self.assertIn("0625", codes)
        self.assertIn("biology", codes)

    def test_every_published_subject_has_a_topic_list(self) -> None:
        missing = sorted(
            code for code in self.published_subject_codes()
            if topics_module.topics_for(code) is None
        )
        self.assertEqual(missing, [], f"no syllabus topics configured for: {missing}")

    def test_topics_within_a_subject_are_unique(self) -> None:
        """A duplicated topic splits a subject's mastery across two rows."""
        for subject in topics_module.configured_subjects():
            found = topics_module.topics_for(subject)
            assert found is not None
            listed = found[0]
            self.assertEqual(
                len(listed), len(set(listed)), f"duplicate topic in {subject}"
            )

    def test_every_topic_is_a_non_empty_single_line(self) -> None:
        for subject in topics_module.configured_subjects():
            found = topics_module.topics_for(subject)
            assert found is not None
            for topic in found[0]:
                self.assertEqual(topic, topic.strip(), f"{subject}: {topic!r}")
                self.assertNotIn("\n", topic, f"{subject}: {topic!r}")


if __name__ == "__main__":
    unittest.main()
