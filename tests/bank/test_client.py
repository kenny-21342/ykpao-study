"""Provider failures that must not trigger duplicate billed attempts."""

from __future__ import annotations

import unittest
import base64
import io
import tempfile
from pathlib import Path
from unittest import mock

from PIL import Image

from pdf_extraction.bank import client


class ClientRetryTests(unittest.TestCase):
    def test_oversized_request_is_not_retried(self) -> None:
        response = mock.Mock(status_code=413, text="request body exceeds the configured limit")
        session = mock.Mock()
        session.post.return_value = response
        with mock.patch.object(client, "_session", return_value=session):
            with self.assertRaises(client.RequestTooLarge):
                client.call_json(
                    endpoint="https://example.invalid/v1/chat/completions",
                    api_key="test-key", model="test-model",
                    system_prompt="transcribe", user_text="one question",
                    max_attempts=3, sleep=lambda seconds: None,
                )
        self.assertEqual(session.post.call_count, 1)

    def test_rejected_image_upload_is_not_retried(self) -> None:
        response = mock.Mock(
            status_code=502,
            text="the upstream rejected image upload (HTTP 417); no image question was sent",
        )
        session = mock.Mock()
        session.post.return_value = response
        with mock.patch.object(client, "_session", return_value=session):
            with self.assertRaises(client.ImageUploadRejected):
                client.call_json(
                    endpoint="https://example.invalid/v1/chat/completions",
                    api_key="test-key", model="test-model",
                    system_prompt="transcribe", user_text="one question",
                    max_attempts=3, sleep=lambda seconds: None,
                )
        self.assertEqual(session.post.call_count, 1)

    def test_large_png_is_uploaded_as_compact_jpeg(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "strip.png"
            Image.effect_noise((1200, 1200), 100).save(path)
            self.assertGreater(path.stat().st_size, 500_000)
            url = client._image_data_url(path)
        self.assertTrue(url.startswith("data:image/jpeg;base64,"))
        data = base64.b64decode(url.partition(",")[2])
        self.assertLessEqual(len(data), 500_000)
        with Image.open(io.BytesIO(data)) as image:
            self.assertLessEqual(max(image.size), 1200)


if __name__ == "__main__":
    unittest.main()
