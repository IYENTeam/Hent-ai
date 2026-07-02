import importlib.util
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

PLUGIN_PATH = Path(__file__).resolve().parents[2] / "hermes" / "__init__.py"
CONTRACT_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "emotion-contract-v1.json"

spec = importlib.util.spec_from_file_location("hent_ai_hermes_plugin", PLUGIN_PATH)
assert spec is not None and spec.loader is not None
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class HermesPluginTests(unittest.TestCase):
    def test_detects_happy_completion(self):
        self.assertEqual(plugin.detect_emotion("Task completed successfully"), "happy")

    def test_detects_sorry(self):
        self.assertEqual(plugin.detect_emotion("Sorry, I made a mistake."), "sorry")

    def test_detects_focused(self):
        self.assertEqual(plugin.detect_emotion("Testing and verifying the fix"), "focused")

    def test_falls_back_to_neutral(self):
        self.assertEqual(plugin.detect_emotion("The weather is mild."), "neutral")

    def test_matches_emotion_contract_v1_keys(self):
        fixture = json.loads(CONTRACT_PATH.read_text())
        self.assertEqual(plugin.EMOTION_CONTRACT_VERSION, "EmotionContractV1")
        self.assertEqual(
            list(plugin.DEFAULT_EMOTION_MAP.keys()),
            fixture["emotions"],
        )

    def test_detects_fixture_contract_examples(self):
        fixture = json.loads(CONTRACT_PATH.read_text())
        for case in fixture["cases"]:
            self.assertEqual(plugin.detect_emotion(case["text"]), case["emotion"])

    def test_skips_unsupported_platform(self):
        with TemporaryDirectory() as tmp:
            image = Path(tmp) / "happy.png"
            image.write_bytes(b"png")
            transformed = plugin.build_transformed_response(
                "Task complete",
                platform="cli",
                assets_dir=Path(tmp),
            )
            self.assertIsNone(transformed)

    def test_appends_media_directive_for_supported_platform(self):
        with TemporaryDirectory() as tmp:
            image = Path(tmp) / "happy.png"
            image.write_bytes(b"png")
            transformed = plugin.build_transformed_response(
                "Task complete",
                platform="discord",
                assets_dir=Path(tmp),
            )
            self.assertIsNotNone(transformed)
            self.assertIn("Task complete", transformed)
            self.assertIn(f"MEDIA:{image.resolve()}", transformed)

    def test_strips_model_supplied_media_directives_before_appending_plugin_media(self):
        with TemporaryDirectory() as tmp:
            image = Path(tmp) / "happy.png"
            image.write_bytes(b"png")
            transformed = plugin.build_transformed_response(
                "Task complete\nMEDIA:/etc/passwd",
                platform="discord",
                assets_dir=Path(tmp),
            )
            self.assertIsNotNone(transformed)
            assert transformed is not None
            self.assertEqual(transformed.count("MEDIA:"), 1)
            self.assertNotIn("/etc/passwd", transformed)
            self.assertIn(f"MEDIA:{image.resolve()}", transformed)

    def test_strips_inline_model_media_directives_before_appending_plugin_media(self):
        with TemporaryDirectory() as tmp:
            image = Path(tmp) / "happy.png"
            image.write_bytes(b"png")
            transformed = plugin.build_transformed_response(
                'Task complete MEDIA:"/tmp/model supplied.png" MEDIA:http://evil.example/happy.png MEDIA:relative.png',
                platform="discord",
                assets_dir=Path(tmp),
            )
            self.assertIsNotNone(transformed)
            assert transformed is not None
            self.assertEqual(transformed.count("MEDIA:"), 1)
            self.assertNotIn("model supplied", transformed)
            self.assertNotIn("evil.example", transformed)
            self.assertNotIn("relative.png", transformed)
            self.assertIn(f"MEDIA:{image.resolve()}", transformed)

    def test_missing_image_leaves_response_unchanged(self):
        with TemporaryDirectory() as tmp:
            transformed = plugin.build_transformed_response(
                "Task complete",
                platform="discord",
                assets_dir=Path(tmp),
            )
            self.assertIsNone(transformed)

    def test_register_adds_transform_hook(self):
        calls = []

        class Ctx:
            def register_hook(self, name, callback):
                calls.append((name, callback))

        plugin.register(Ctx())
        self.assertEqual(calls[0][0], "transform_llm_output")
        self.assertTrue(callable(calls[0][1]))


if __name__ == "__main__":
    unittest.main()
