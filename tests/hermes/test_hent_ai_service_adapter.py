import importlib.util
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).resolve().parents[2] / "hermes" / "__init__.py"
FAKE_SERVICE_PATH = Path(__file__).resolve().parent / "fake_hent_service.py"
VALID_EMOTIONS = ["sorry", "happy", "confused", "focused", "loyalty", "neutral"]

fake_service_spec = importlib.util.spec_from_file_location("hent_ai_fake_service", FAKE_SERVICE_PATH)
assert fake_service_spec is not None and fake_service_spec.loader is not None
fake_service_module = importlib.util.module_from_spec(fake_service_spec)
fake_service_spec.loader.exec_module(fake_service_module)
FakeHentService = fake_service_module.FakeHentService

spec = importlib.util.spec_from_file_location("hent_ai_hermes_plugin", PLUGIN_PATH)
assert spec is not None and spec.loader is not None
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def registered_transform():
    calls = []

    class Ctx:
        def register_hook(self, name, callback):
            calls.append((name, callback))

    plugin.register(Ctx())
    return calls[0][1]


class HermesServiceAdapterTests(unittest.TestCase):
    def test_service_verdict_appends_cached_media_directive(self):
        seen_requests = []

        def handler(method, path, request_body, headers):
            if method == "POST" and path == "/v1/final-response/verdict":
                seen_requests.append(
                    {
                        "authorization": headers.get("Authorization"),
                        "body": json.loads(request_body.decode("utf-8")),
                    }
                )
                return (
                    200,
                    {"Content-Type": "application/json"},
                    {
                        "verdict": {
                            "emotion": "happy",
                            "media": {
                                "url": "/static/sets/default/happy.png",
                                "filename": "happy.png",
                                "contentType": "image/png",
                            },
                        }
                    },
                )
            if method == "GET" and path == "/static/sets/default/happy.png":
                return 200, {"Content-Type": "image/png"}, b"fake-png"
            return 404, {"Content-Type": "text/plain"}, b"missing"

        with FakeHentService(handler) as base_url, TemporaryDirectory() as cache_dir:
            with patch.dict(
                os.environ,
                {
                    "HENT_AI_SERVICE_URL": base_url,
                    "HENT_AI_SERVICE_TOKEN": "secret-token",
                    "HENT_AI_HERMES_CACHE_DIR": cache_dir,
                },
            ):
                transformed = registered_transform()(
                    "I am happy\nMEDIA:/etc/passwd",
                    platform="discord",
                    channel_id="discord-channel-1",
                )

            self.assertIsNotNone(transformed)
            assert transformed is not None
            self.assertIn("I am happy", transformed)
            self.assertNotIn("/etc/passwd", transformed)
            self.assertEqual(transformed.count("MEDIA:"), 1)

            media_path = Path(transformed.split("MEDIA:", 1)[1].strip())
            self.assertTrue(media_path.exists())
            self.assertEqual(media_path.read_bytes(), b"fake-png")

        request_body = seen_requests[0]["body"]
        self.assertEqual(seen_requests[0]["authorization"], "Bearer secret-token")
        self.assertEqual(request_body["context"]["channelId"], "discord-channel-1")
        self.assertEqual(request_body["context"]["content"], "I am happy")
        self.assertEqual(request_body["context"]["validEmotions"], VALID_EMOTIONS)

    def test_service_error_fails_closed_without_local_fallback(self):
        def handler(method, path, request_body, headers):
            if method == "POST" and path == "/v1/final-response/verdict":
                return 500, {"Content-Type": "application/json"}, {"error": "boom"}
            return 404, {"Content-Type": "text/plain"}, b"missing"

        with FakeHentService(handler) as base_url, TemporaryDirectory() as tmp:
            image = Path(tmp) / "happy.png"
            image.write_bytes(b"local-fallback-should-not-be-used")
            with patch.dict(
                os.environ,
                {
                    "HENT_AI_SERVICE_URL": base_url,
                    "HENT_AI_SERVICE_TOKEN": "secret-token",
                    "HENT_AI_HERMES_CACHE_DIR": str(Path(tmp) / "cache"),
                },
            ):
                transformed = plugin.build_transformed_response(
                    "Task complete",
                    platform="discord",
                    assets_dir=Path(tmp),
                    channel_id="discord-channel-1",
                )

        self.assertIsNone(transformed)

    def test_registered_hook_strips_inline_model_media_when_service_fails(self):
        def handler(method, path, request_body, headers):
            if method == "POST" and path == "/v1/final-response/verdict":
                return 500, {"Content-Type": "application/json"}, {"error": "boom"}
            return 404, {"Content-Type": "text/plain"}, b"missing"

        with FakeHentService(handler) as base_url:
            with patch.dict(
                os.environ,
                {
                    "HENT_AI_SERVICE_URL": base_url,
                    "HENT_AI_SERVICE_TOKEN": "secret-token",
                },
            ):
                transformed = registered_transform()(
                    "Task complete MEDIA:/etc/passwd MEDIA:http://evil.example/happy.png MEDIA:relative.png",
                    platform="discord",
                    channel_id="discord-channel-1",
                )

        self.assertEqual(transformed, "Task complete")

    def test_registered_hook_rejects_cross_origin_service_media(self):
        seen_paths = []

        def handler(method, path, request_body, headers):
            seen_paths.append(path)
            if method == "POST" and path == "/v1/final-response/verdict":
                return (
                    200,
                    {"Content-Type": "application/json"},
                    {
                        "verdict": {
                            "emotion": "happy",
                            "media": {
                                "url": "http://example.invalid/static/happy.png",
                                "filename": "happy.png",
                                "contentType": "image/png",
                            },
                        }
                    },
                )
            return 404, {"Content-Type": "text/plain"}, b"missing"

        with FakeHentService(handler) as base_url:
            with patch.dict(
                os.environ,
                {
                    "HENT_AI_SERVICE_URL": base_url,
                    "HENT_AI_SERVICE_TOKEN": "secret-token",
                },
            ):
                transformed = registered_transform()(
                    "Task complete MEDIA:/etc/passwd",
                    platform="discord",
                    channel_id="discord-channel-1",
                )

        self.assertEqual(transformed, "Task complete")
        self.assertEqual(seen_paths, ["/v1/final-response/verdict"])

    def test_invalid_service_config_fails_closed_without_local_fallback(self):
        with TemporaryDirectory() as tmp:
            image = Path(tmp) / "happy.png"
            image.write_bytes(b"local-fallback-should-not-be-used")
            with patch.dict(
                os.environ,
                {
                    "HENT_AI_SERVICE_URL": "not a url",
                    "HENT_AI_SERVICE_TOKEN": "secret-token",
                },
            ):
                transformed = plugin.build_transformed_response(
                    "Task complete",
                    platform="discord",
                    assets_dir=Path(tmp),
                    channel_id="discord-channel-1",
                )

        self.assertIsNone(transformed)


if __name__ == "__main__":
    unittest.main()
