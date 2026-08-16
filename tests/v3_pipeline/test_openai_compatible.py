from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pdf_extraction.v3.model import extraction_job
from pdf_extraction.v3.openai_compatible import ProviderResponseError, _messages_for_job, run_json_job


class OpenAICompatibleAdapterTests(unittest.TestCase):
    def test_extraction_job_uses_document_specific_response_contract(self) -> None:
        preflight = {"pages": [{
            "page": 1,
            "classification": "question_content",
            "renderPath": "/tmp/page.png",
            "width": 600,
            "height": 800,
            "acceptedBlocks": [],
            "acceptedDrawings": [],
            "figureCandidates": [],
        }]}

        question_job = extraction_job({"document_type": "question_paper"}, preflight)
        self.assertTrue(question_job["responseContract"]["questions"])
        self.assertEqual(question_job["responseContract"]["markSchemes"], [])
        self.assertIn("Return questions only", question_job["requirements"]["documentType"])

        mark_scheme_job = extraction_job({"document_type": "mark_scheme"}, preflight)
        self.assertEqual(mark_scheme_job["responseContract"]["questions"], [])
        self.assertTrue(mark_scheme_job["responseContract"]["markSchemes"])
        self.assertIn("Return markSchemes only", mark_scheme_job["requirements"]["documentType"])

    def test_probe_attaches_image_without_leaking_path_into_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image = Path(temp_dir) / "page.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            messages = _messages_for_job({
                "task": "probe-image-transcription",
                "imagePath": str(image),
                "responseContract": {"readable": "boolean"},
                "localValidation": {"exactTranscription": "must stay local"},
            })
            user_content = messages[1]["content"]
            self.assertNotIn(str(image), user_content[0]["text"])
            self.assertNotIn("must stay local", user_content[0]["text"])
            self.assertTrue(user_content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

    @patch("pdf_extraction.v3.openai_compatible._post_json")
    def test_retries_invalid_grounding_then_stops(self, post_json) -> None:
        post_json.return_value = {
            "choices": [{"message": {"content": json.dumps({
                "readable": True,
                "transcription": "A different question",
                "marks": 3,
            })}}],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            image = Path(temp_dir) / "page.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            with self.assertRaisesRegex(ProviderResponseError, "after 3 attempts"):
                run_json_job(
                    {"task": "probe-image-transcription", "imagePath": str(image)},
                    endpoint="https://example.invalid/v1/chat/completions",
                    api_key="secret",
                    model="gpt-5.4",
                    max_attempts=3,
                    sleep=lambda _: None,
                )
        self.assertEqual(post_json.call_count, 3)

    @patch("pdf_extraction.v3.openai_compatible._post_json")
    def test_accepts_source_grounded_probe_and_records_returned_model(self, post_json) -> None:
        post_json.return_value = {
            "id": "response-1",
            "model": "provider-model-name",
            "usage": {"prompt_tokens": 10, "completion_tokens": 20},
            "choices": [{"message": {"content": json.dumps({
                "readable": True,
                "transcription": (
                    "1 The equation of a curve is such that dy/dx = 4/(x-3)^3 for x > 3. "
                    "The curve passes through the point (4, 5). Find the equation of the curve. [3]"
                ),
                "marks": 3,
            })}}],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            image = Path(temp_dir) / "page.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            result = run_json_job(
                {"task": "probe-image-transcription", "imagePath": str(image)},
                endpoint="https://example.invalid/v1/chat/completions",
                api_key="secret",
                model="gpt-5.4",
                sleep=lambda _: None,
            )
        self.assertEqual(result.returned_model, "provider-model-name")
        self.assertEqual(result.usage["inputTokens"], 10)
        self.assertEqual(post_json.call_count, 1)

    @patch("pdf_extraction.v3.openai_compatible._post_json")
    def test_preserves_attempts_and_redacts_key(self, post_json) -> None:
        post_json.return_value = {
            "debug": "secret-key",
            "choices": [{"message": {"content": json.dumps({
                "readable": True,
                "transcription": "wrong source",
                "marks": 3,
            })}}],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "page.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n")
            with self.assertRaises(ProviderResponseError) as raised:
                run_json_job(
                    {"task": "probe-image-transcription", "imagePath": str(image)},
                    endpoint="https://example.invalid/v1/chat/completions",
                    api_key="secret-key",
                    model="model",
                    max_attempts=1,
                    artifact_dir=root / "attempts",
                    sleep=lambda _: None,
                )
            artifacts = "".join(path.read_text() for path in (root / "attempts").iterdir())
        self.assertNotIn("secret-key", artifacts)
        self.assertIn("[REDACTED]", artifacts)
        self.assertEqual(raised.exception.diagnostics[0]["attempt"], 1)

    @patch("pdf_extraction.v3.openai_compatible._post_json")
    def test_accepts_mark_scheme_with_grounded_provenance(self, post_json) -> None:
        post_json.return_value = self._mark_scheme_provider_response()
        with tempfile.TemporaryDirectory() as temp_dir:
            job = self._mark_scheme_job(Path(temp_dir))
            result = run_json_job(
                job,
                endpoint="https://example.invalid/v1/chat/completions",
                api_key="secret",
                model="model",
                max_attempts=1,
                sleep=lambda _: None,
            )
        self.assertEqual(result.content["questions"], [])
        self.assertEqual(result.content["markSchemes"][0]["rootNumber"], "1")

    @patch("pdf_extraction.v3.openai_compatible._post_json")
    def test_rejects_mark_scheme_with_unknown_provenance(self, post_json) -> None:
        response = self._mark_scheme_provider_response()
        content = json.loads(response["choices"][0]["message"]["content"])
        content["markSchemes"][0]["sections"][0]["points"][0]["provenance"][0][
            "nativeBlockIds"
        ] = ["invented-block"]
        response["choices"][0]["message"]["content"] = json.dumps(content)
        post_json.return_value = response
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(ProviderResponseError, "unknown nativeBlockIds"):
                run_json_job(
                    self._mark_scheme_job(Path(temp_dir)),
                    endpoint="https://example.invalid/v1/chat/completions",
                    api_key="secret",
                    model="model",
                    max_attempts=1,
                    sleep=lambda _: None,
                )

    @staticmethod
    def _mark_scheme_job(temp_dir: Path) -> dict:
        image = temp_dir / "page.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n")
        return {
            "task": "extract-question-document-v1",
            "metadata": {"document_type": "mark_scheme"},
            "pages": [{
                "page": 1,
                "imagePath": str(image),
                "width": 600,
                "height": 800,
                "acceptedBlocks": [{"id": "native-1"}],
            }],
        }

    @staticmethod
    def _mark_scheme_provider_response() -> dict:
        return {"choices": [{"message": {"content": json.dumps({
            "questions": [],
            "markSchemes": [{
                "rootNumber": "1",
                "marks": 1,
                "sections": [{
                    "path": [],
                    "label": "1",
                    "points": [{
                        "markCode": "B1",
                        "marks": 1,
                        "answer": [{"type": "text", "text": "Correct answer"}],
                        "alternatives": [],
                        "acceptableAnswers": [],
                        "notes": [],
                        "provenance": [{
                            "sourceDocumentId": "doc-1",
                            "page": 1,
                            "bbox": {"x0": 20, "y0": 30, "x1": 200, "y1": 80},
                            "nativeBlockIds": ["native-1"],
                        }],
                    }],
                }],
            }],
            "assets": [],
            "topicAssignments": {"1": []},
            "tagAssignments": {"1": []},
        })}}]}


if __name__ == "__main__":
    unittest.main()
