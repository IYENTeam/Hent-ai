"""Tests for the Hermes watcher adapter, the minimal LLM client, and the single
composed transform_llm_output path. LLM/network are always mocked.
"""

import importlib.util
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

_ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, _ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


adapter = _load("hent_ai_watcher_adapter_t", "hermes/watcher_adapter.py")
llm = _load("hent_ai_llm_client_t", "hermes/llm_client.py")
plugin = _load("hent_ai_hermes_plugin_t", "hermes/__init__.py")

REPEAT = "ship the release today ship the release today"


class CapLogger:
    def __init__(self) -> None:
        self.infos = []
        self.warns = []

    def info(self, *a: object) -> None:
        self.infos.append(" ".join(str(x) for x in a))

    def warn(self, *a: object) -> None:
        self.warns.append(" ".join(str(x) for x in a))


def make(config, **over):
    clock = [1000]
    log = CapLogger()
    deps = {
        "config": config,
        "logger": log,
        "critic": over.get("critic", lambda s, c, t: {"fixated": True, "confidence": 0.9}),
        "generate": over.get("generate", lambda s, c: "Let's explore a fresh angle."),
        "moderate": over.get("moderate", lambda t: True),
        "now": lambda: clock[0],
        "isoNow": lambda: "2026-06-16T00:00:00.000Z",
    }
    if "critic_absent" in over:
        for k in ("critic", "generate", "moderate"):
            deps.pop(k)
    a = adapter.create_hermes_watcher_adapter(deps)
    return a, log, clock


class HermesAdapterTests(unittest.TestCase):
    def test_shadow_mode_returns_no_nudge_but_audits(self):
        a, log, _ = make({"enabled": True})  # shadow defaults on
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))  # prime, no signal
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))  # signal, shadow -> no nudge
        audits = [l for l in log.infos if "watcher: scope=" in l]
        self.assertEqual(len(audits), 1)
        self.assertIn("suppressed=shadow_mode", audits[0])
        self.assertIn("nudged=no", audits[0])

    def test_live_returns_nudge_text(self):
        a, _, _ = make({"enabled": True, "shadowMode": False})
        a["on_agent_turn"]("s1", REPEAT)
        self.assertEqual(a["on_agent_turn"]("s1", REPEAT), "Let's explore a fresh angle.")

    def test_cooldown_suppresses_after_a_nudge(self):
        a, _, _ = make({"enabled": True, "shadowMode": False, "cooldownMs": 600000})
        a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(a["on_agent_turn"]("s1", REPEAT))  # nudges, commits cooldown
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))  # within cooldown -> suppressed

    def test_budget_exhaustion_fail_closes(self):
        a, log, _ = make({"enabled": True, "shadowMode": False, "cooldownMs": 0, "budgetPerHour": 1})
        a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(a["on_agent_turn"]("s1", REPEAT))  # uses the one budget unit
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))  # budget exhausted
        self.assertTrue(any("budget exceeded" in w for w in log.warns))

    def test_critic_null_fail_closes(self):
        a, log, _ = make({"enabled": True, "shadowMode": False}, critic=lambda s, c, t: None)
        a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))
        self.assertTrue(any("critic returned null" in w for w in log.warns))

    def test_low_confidence_does_not_nudge(self):
        a, _, _ = make({"enabled": True, "shadowMode": False}, critic=lambda s, c, t: {"fixated": True, "confidence": 0.4})
        a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))

    def test_moderation_failure_suppresses(self):
        a, log, _ = make({"enabled": True, "shadowMode": False}, moderate=lambda t: False)
        a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))
        self.assertTrue(any("moderation failed" in w for w in log.warns))

    def test_missing_llm_deps_fail_closes(self):
        a, log, _ = make({"enabled": True, "shadowMode": False}, critic_absent=True)
        a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))
        self.assertTrue(any("LLM critic/generator/moderator missing" in w for w in log.warns))

    def test_disabled_is_noop(self):
        a, _, _ = make({"enabled": False})
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))

    def test_transcript_store_windowing_and_eviction(self):
        a, _, clock = make({"enabled": True})
        for i in range(12):
            a["on_agent_turn"]("s1", f"turn {i}")
        self.assertEqual(a["scope_count"](), 1)
        clock[0] = 1000 + adapter.WATCHER_SCOPE_TTL_MS + 1
        a["on_agent_turn"]("s2", "new scope")
        self.assertEqual(a["scope_count"](), 1)  # idle s1 evicted


class ComposeOrderingTests(unittest.TestCase):
    def test_steer_replaces_the_repeat_and_precedes_the_media_directive(self):
        with TemporaryDirectory() as tmp:
            (Path(tmp) / "neutral.png").write_bytes(b"png")
            base = adapter.compose_nudge("the weather is mild", "Maybe shift the focus elsewhere?")
            result = plugin.build_transformed_response(base, platform="discord", assets_dir=Path(tmp))
            assert result is not None
            # Mode B: the duplicate prose is dropped; only the steer survives, ahead of MEDIA.
            self.assertNotIn("the weather is mild", result)
            self.assertIn("Maybe shift the focus elsewhere?", result)
            self.assertLess(result.index("Maybe shift the focus elsewhere?"), result.index("MEDIA:"))


class LlmClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k) for k in (
            "HENT_AI_LLM_API", "HENT_AI_LLM_BASE_URL", "HENT_AI_LLM_API_KEY", "HENT_AI_LLM_MODEL")}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    @staticmethod
    def _urlopen(body: str):
        class _Resp:
            def read(self_inner):
                return body.encode("utf-8")

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

        def _open(req, timeout=None):
            return _Resp()

        return _open

    def test_fail_closed_without_config(self):
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('{"choices":[]}')))

    def test_openai_success(self):
        os.environ["HENT_AI_LLM_API_KEY"] = "k"
        os.environ["HENT_AI_LLM_MODEL"] = "m"
        body = '{"choices":[{"message":{"content":"hello"}}]}'
        self.assertEqual(llm.call_chat("hi", urlopen=self._urlopen(body)), "hello")

    def test_anthropic_success(self):
        os.environ["HENT_AI_LLM_API"] = "anthropic"
        os.environ["HENT_AI_LLM_API_KEY"] = "k"
        os.environ["HENT_AI_LLM_MODEL"] = "m"
        body = '{"content":[{"type":"text","text":"yo"}]}'
        self.assertEqual(llm.call_chat("hi", system="s", urlopen=self._urlopen(body)), "yo")

    def test_http_error_fail_closes(self):
        os.environ["HENT_AI_LLM_API_KEY"] = "k"
        os.environ["HENT_AI_LLM_MODEL"] = "m"

        def boom(req, timeout=None):
            raise RuntimeError("network down")

        self.assertIsNone(llm.call_chat("hi", urlopen=boom))

    def test_bad_json_fail_closes(self):
        os.environ["HENT_AI_LLM_API_KEY"] = "k"
        os.environ["HENT_AI_LLM_MODEL"] = "m"
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen("not json")))

    def test_call_chat_json_parses_and_tolerates_fences(self):
        os.environ["HENT_AI_LLM_API_KEY"] = "k"
        os.environ["HENT_AI_LLM_MODEL"] = "m"
        body = '{"choices":[{"message":{"content":"```json\\n{\\"fixated\\": true, \\"confidence\\": 0.8}\\n```"}}]}'
        parsed = llm.call_chat_json("hi", urlopen=self._urlopen(body))
        self.assertEqual(parsed, {"fixated": True, "confidence": 0.8})

    def test_call_chat_json_returns_none_without_object(self):
        os.environ["HENT_AI_LLM_API_KEY"] = "k"
        os.environ["HENT_AI_LLM_MODEL"] = "m"
        body = '{"choices":[{"message":{"content":"no json here"}}]}'
        self.assertIsNone(llm.call_chat_json("hi", urlopen=self._urlopen(body)))


class RegisterComposedHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k) for k in (
            "HENT_AI_WATCHER_ENABLED", "HENT_AI_WATCHER_SHADOW", "HENT_AI_ASSET_DIR", "HENT_AI_HERMES_PLATFORMS")}

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _register(self):
        captured = {}

        class Ctx:
            def register_hook(self, name, callback):
                captured[name] = callback

        plugin.register(Ctx())
        return captured

    def test_registers_single_transform_hook_when_watcher_disabled(self):
        os.environ.pop("HENT_AI_WATCHER_ENABLED", None)
        captured = self._register()
        self.assertIn("transform_llm_output", captured)
        self.assertTrue(callable(captured["transform_llm_output"]))

    def test_composed_hook_replaces_response_with_steer_then_media(self):
        with TemporaryDirectory() as tmp:
            (Path(tmp) / "neutral.png").write_bytes(b"png")
            os.environ["HENT_AI_WATCHER_ENABLED"] = "1"
            os.environ["HENT_AI_ASSET_DIR"] = tmp
            os.environ["HENT_AI_HERMES_PLATFORMS"] = "discord"
            # Force a deterministic nudge by swapping the watcher loader.
            original = plugin._load_watcher_adapter

            class _Stub:
                @staticmethod
                def create_hermes_watcher_adapter(_deps):
                    return {"on_agent_turn": lambda scope, text: "Consider a different topic."}

                compose_nudge = staticmethod(adapter.compose_nudge)

            plugin._load_watcher_adapter = lambda: _Stub  # type: ignore[assignment]
            try:
                hook = self._register()["transform_llm_output"]
                result = hook("the weather is mild", platform="discord")
            finally:
                plugin._load_watcher_adapter = original
            assert result is not None
            # Mode B: the duplicate prose is dropped; only the steer + MEDIA remain.
            self.assertNotIn("the weather is mild", result)
            self.assertLess(result.index("Consider a different topic."), result.index("MEDIA:"))


class BuildWatcherLlmTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k) for k in ("HENT_AI_LLM_API_KEY", "HENT_AI_LLM_MODEL", "HENT_AI_WATCHER_PERSONA")}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_none_without_llm_config(self):
        self.assertIsNone(plugin._build_watcher_llm())

    def test_builds_layer_when_configured(self):
        os.environ["HENT_AI_LLM_API_KEY"] = "k"
        os.environ["HENT_AI_LLM_MODEL"] = "m"
        layer = plugin._build_watcher_llm()
        self.assertIsNotNone(layer)
        for key in ("critic", "generate", "moderate"):
            self.assertIn(key, layer)
            self.assertTrue(callable(layer[key]))


if __name__ == "__main__":
    unittest.main()
