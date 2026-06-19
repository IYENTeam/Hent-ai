import importlib.util
import re
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

PLUGIN_PATH = Path(__file__).resolve().parents[2] / "hermes" / "__init__.py"

spec = importlib.util.spec_from_file_location("hent_ai_hermes_plugin", PLUGIN_PATH)
plugin = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(plugin)


def _extract_shared_emotion_regexes() -> dict[str, list[str]]:
    """Extract regex literal sources from shared/emotions.ts for parity tests.

    This intentionally checks the duplicated Hermes lightweight rule table against
    the canonical shared/Cursor rules so future hand edits cannot silently drift.
    """
    shared_path = Path(__file__).resolve().parents[2] / "shared" / "emotions.ts"
    source = shared_path.read_text()
    result: dict[str, list[str]] = {}
    for match in re.finditer(r'id: "(?P<emotion>[^"]+)",\n\s+defaultFile: "[^"]+",\n\s+patterns: \[(?P<body>.*?)\],', source, re.S):
        emotion = match.group("emotion")
        body = match.group("body")
        result[emotion] = re.findall(r'/((?:\\/|[^/])*)/i', body)
    return result


def _hermes_regexes() -> dict[str, list[str]]:
    return {emotion: [pattern.pattern for pattern in patterns] for emotion, patterns in plugin.EMOTION_RULES}


class HermesPluginTests(unittest.TestCase):
    def test_detects_happy_completion(self):
        self.assertEqual(plugin.detect_emotion("Task completed successfully"), "happy")

    def test_detects_sorry(self):
        self.assertEqual(plugin.detect_emotion("Sorry, I made a mistake."), "sorry")

    def test_detects_focused(self):
        self.assertEqual(plugin.detect_emotion("Testing and verifying the fix"), "focused")

    def test_falls_back_to_neutral(self):
        self.assertEqual(plugin.detect_emotion("The weather is mild."), "neutral")

    def test_detects_korean_happy(self):
        # HENT-AUDIT-009 (#46): Korean parity with shared/Cursor rules
        self.assertEqual(plugin.detect_emotion("파일 수정이 완료되었습니다"), "happy")
        self.assertEqual(plugin.detect_emotion("빌드 성공했습니다"), "happy")
        self.assertEqual(plugin.detect_emotion("테스트 통과!"), "happy")

    def test_detects_korean_sorry(self):
        self.assertEqual(plugin.detect_emotion("죄송합니다, 실수가 있었습니다"), "sorry")
        self.assertEqual(plugin.detect_emotion("에러가 발생했습니다"), "sorry")

    def test_detects_korean_confused(self):
        self.assertEqual(plugin.detect_emotion("추가 확인이 필요합니다"), "confused")
        self.assertEqual(plugin.detect_emotion("잘 모르겠습니다"), "confused")

    def test_detects_korean_focused(self):
        self.assertEqual(plugin.detect_emotion("코드를 분석하고 있습니다"), "focused")
        self.assertEqual(plugin.detect_emotion("디버깅 중입니다"), "focused")

    def test_detects_korean_loyalty(self):
        self.assertEqual(plugin.detect_emotion("네, 알겠습니다"), "loyalty")
        self.assertEqual(plugin.detect_emotion("바로 시작하겠습니다"), "loyalty")


    def test_hermes_rules_match_shared_source_of_truth(self):
        shared = _extract_shared_emotion_regexes()
        hermes = _hermes_regexes()
        for emotion in ("sorry", "happy", "confused", "focused", "loyalty"):
            self.assertEqual(hermes[emotion], shared[emotion])

    def test_korean_first_match_precedence_and_substring_traps_match_shared_rules(self):
        # These broad fragments are inherited from shared/emotions.ts. This test
        # locks first-match behavior so future edits must consciously update the
        # canonical shared rules instead of drifting Hermes locally.
        cases = {
            "죄송합니다. 테스트 통과했습니다": "sorry",
            "문제 없습니다만 추가 확인이 필요합니다": "happy",
            "확인했습니다": "focused",
            "바로 시작하겠습니다": "loyalty",
            "에러가 발생하지 않았습니다": "sorry",
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(plugin.detect_emotion(text), expected)

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
