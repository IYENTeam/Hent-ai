import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).resolve().parents[2] / "hermes" / "__init__.py"

spec = importlib.util.spec_from_file_location("hent_ai_hermes_plugin", PLUGIN_PATH)
assert spec is not None and spec.loader is not None
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
service_adapter = plugin._load_service_adapter()


class HermesServiceConfigTransportTests(unittest.TestCase):
    def test_config_rejects_remote_plaintext_http(self):
        config = service_adapter.config_from_env(
            {
                "HENT_AI_SERVICE_URL": "http://example.com:8787",
                "HENT_AI_SERVICE_TOKEN": "secret-token",
            }
        )

        self.assertIsNone(config)

    def test_remote_plaintext_http_makes_no_bearer_request(self):
        attempted_authorizations = []

        def fail_if_requested(request, timeout):
            attempted_authorizations.append(request.get_header("Authorization"))
            raise AssertionError("remote plaintext request attempted")

        with (
            patch.dict(
                os.environ,
                {
                    "HENT_AI_SERVICE_URL": "http://example.com:8787",
                    "HENT_AI_SERVICE_TOKEN": "secret-token",
                },
            ),
            patch.object(service_adapter, "urlopen", side_effect=fail_if_requested),
        ):
            transformed = service_adapter.transformed_response(
                "Task complete",
                platform="discord",
                hook_context={"channel_id": "discord-channel-1"},
            )

        self.assertIsNone(transformed)
        self.assertEqual(attempted_authorizations, [])

    def test_config_accepts_remote_https(self):
        config = service_adapter.config_from_env(
            {
                "HENT_AI_SERVICE_URL": "https://example.com:8787/",
                "HENT_AI_SERVICE_TOKEN": "secret-token",
            }
        )

        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual(config.base_url, "https://example.com:8787")

    def test_config_accepts_plaintext_loopback_hosts(self):
        for url in (
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
            "http://agent.localhost:8787",
        ):
            with self.subTest(url=url):
                config = service_adapter.config_from_env(
                    {
                        "HENT_AI_SERVICE_URL": url,
                        "HENT_AI_SERVICE_TOKEN": "secret-token",
                    }
                )

                self.assertIsNotNone(config)
                assert config is not None
                self.assertEqual(config.base_url, url)

    def test_config_uses_default_loopback_url_with_token(self):
        config = service_adapter.config_from_env({"HENT_AI_SERVICE_TOKEN": "secret-token"})

        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual(config.base_url, "http://127.0.0.1:8787")

    def test_config_fails_closed_without_nonblank_token(self):
        for env in (
            {},
            {"HENT_AI_SERVICE_TOKEN": ""},
            {"HENT_AI_SERVICE_TOKEN": " \t\n "},
        ):
            with self.subTest(env=env):
                self.assertIsNone(service_adapter.config_from_env(env))

    def test_config_trims_token(self):
        config = service_adapter.config_from_env({"HENT_AI_SERVICE_TOKEN": "  secret-token\n"})

        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual(config.token, "secret-token")


if __name__ == "__main__":
    unittest.main()
