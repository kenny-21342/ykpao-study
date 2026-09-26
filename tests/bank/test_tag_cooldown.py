"""A provider cooldown must pause a tagging run, not consume it.

The first full tagging run lost 4,763 of 15,737 attempted questions on
26 Sep 2026. Every loss was HTTP 429 -- "all eligible accounts are cooling
down" -- and every one landed in the ledger as `failed`. `client.call_json`
backs off, but only across its three attempts and only by 1s then 2s when the
429 carries no `Retry-After`, which this provider's does not. Three requests
inside four seconds against a quota window measured in minutes is not a retry.

The cost was not the money -- a refused call bills nothing -- it was that
throughput fell from 10,000/h to 228/h while the run kept hammering an endpoint
that was asking it to stop, and that a resume then had thousands of rows to
redo.

These tests pin the two properties that fix it: a throttled question is put
back rather than recorded, and the run stops rather than spinning once the
provider stays shut.
"""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from pdf_extraction.bank import store, tag_corpus
from pdf_extraction.bank.client import ProviderError, RateLimited


class CooldownDetectionTests(unittest.TestCase):
    def test_a_wrapped_rate_limit_is_recognised_through_its_cause(self) -> None:
        # `call_json` raises ProviderError *from* the last error, so the typed
        # exception is only reachable on __cause__.
        cause = RateLimited("cooling down", retry_after=0.0)
        try:
            raise ProviderError("no valid response after 3 attempts") from cause
        except ProviderError as error:
            self.assertTrue(tag_corpus._is_cooldown(error))

    def test_the_provider_wording_is_recognised_without_the_type(self) -> None:
        error = ProviderError(
            'no valid response after 3 attempts: HTTP 429: {"error":'
            '{"message":"all eligible accounts are cooling down; retry later"}}')
        self.assertTrue(tag_corpus._is_cooldown(error))

    def test_a_real_fault_is_not_mistaken_for_a_cooldown(self) -> None:
        # The distinction matters in both directions: treating a malformed
        # response as a cooldown would park the run forever on one bad question.
        self.assertFalse(tag_corpus._is_cooldown(
            ProviderError("no valid response after 3 attempts: HTTP 400: bad request")))
        self.assertFalse(tag_corpus._is_cooldown(ValueError("model returned no topics")))


class CooldownRunTests(unittest.TestCase):
    """Drive `main()` against a store of three questions and a fake provider."""

    def setUp(self) -> None:
        self._directory = TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.db = Path(self._directory.name) / "extract.db"
        connection = sqlite3.connect(self.db)
        connection.row_factory = sqlite3.Row
        connection.executescript(store.SCHEMA_PATH.read_text(encoding="utf-8"))
        subject_id = store.upsert_subject(
            connection, board="CAIE", code="0610", name="Biology", level="igcse")
        paper_id = store.upsert_paper(
            connection, subject_id=subject_id,
            identity=store.PaperIdentity(code="0610", board="CAIE", year=2023,
                                         session="s", paper_number=4, variant=1,
                                         doc_type="qp"),
            source_path="/corpus/p.pdf", source_sha256="c" * 64,
            page_count=2, span_strategy="prose", used_ocr=False)
        for root in (1, 2, 3):
            connection.execute(
                "INSERT INTO bank_questions (paper_id, root_number, body_md, status) "
                "VALUES (?, ?, 'Describe osmosis. [3]', 'published')", (paper_id, root))
        connection.commit()
        connection.close()

    def _run(self, tagger, waits=(0.0, 0.0)) -> None:
        argv = ["tag_corpus", "--apply", "--concurrency", "1", "--max-spend", "10"]
        with mock.patch.object(tag_corpus, "DB", self.db), \
             mock.patch.object(tag_corpus, "COOLDOWN_WAITS", waits), \
             mock.patch.object(tag_corpus, "COOLDOWN_GIVE_UP_AFTER", len(waits)), \
             mock.patch.object(tag_corpus, "text_settings",
                               return_value={"model": "m", "endpoint": "http://x"}), \
             mock.patch.object(tag_corpus, "topics_for", return_value=(["Osmosis"], None)), \
             mock.patch.object(tag_corpus, "tag_and_rate", tagger), \
             mock.patch("sys.argv", argv):
            tag_corpus.main()

    def _ledger(self) -> dict[str, int]:
        connection = sqlite3.connect(self.db)
        rows = connection.execute(
            "SELECT status, count(*) FROM bank_run_ledger WHERE stage = 'tag' GROUP BY 1"
        ).fetchall()
        connection.close()
        return {status: count for status, count in rows}

    @staticmethod
    def _cooldown():
        return ProviderError("HTTP 429: all eligible accounts are cooling down")

    def test_a_cooldown_records_nothing_and_the_work_survives_it(self) -> None:
        # Refuse the first pass entirely, then succeed. Before the fix the first
        # pass wrote three `failed` rows and the questions were never retried
        # inside the run at all.
        calls = {"n": 0}

        def tagger(body, topics, context, settings=None):
            calls["n"] += 1
            if calls["n"] <= 3:
                raise self._cooldown()
            return ({"topics": ["Osmosis"], "difficulty": 3}, mock.Mock(input_tokens=10,
                                                                       output_tokens=5))

        self._run(tagger)
        self.assertEqual(self._ledger(), {"ok": 3})

    def test_a_permanent_cooldown_stops_instead_of_spinning(self) -> None:
        def tagger(body, topics, context, settings=None):
            raise self._cooldown()

        self._run(tagger, waits=(0.0,))
        # Nothing succeeded and -- the point -- nothing was burned either, so a
        # later re-run starts from all three rather than redoing them as
        # failures.
        self.assertEqual(self._ledger(), {})

    def test_a_genuine_failure_is_still_recorded(self) -> None:
        def tagger(body, topics, context, settings=None):
            raise ProviderError("HTTP 400: bad request")

        self._run(tagger)
        self.assertEqual(self._ledger(), {"failed": 3})


if __name__ == "__main__":
    unittest.main()
