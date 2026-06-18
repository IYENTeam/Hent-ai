"""Tests for the Hermes watcher LLM layer (prompts, parsing, moderation, factory).
The chat function is always mocked; no network."""

import importlib.util
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("hent_ai_watcher_llm_t", _ROOT / "hermes" / "watcher_llm.py")
llm = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(llm)

CONTEXT = {"currentTopic": "deploy staging server"}
SIGNAL = {"staleFrame": "deploy staging server", "suggestedPivot": "Discuss rollout risks."}


class BuildCriticPromptTests(unittest.TestCase):
    def test_includes_topic_and_last_five_turns(self):
        prompt = llm.build_critic_prompt(CONTEXT, ["t1", "t2", "t3", "t4", "t5", "t6"])
        self.assertIn("deploy staging server", prompt)
        self.assertIn("t6", prompt)
        self.assertNotIn("t1", prompt)


class ParseCriticResponseTests(unittest.TestCase):
    def test_returns_none_for_malformed(self):
        self.assertIsNone(llm.parse_critic_response(None))
        self.assertIsNone(llm.parse_critic_response(""))
        self.assertIsNone(llm.parse_critic_response("no json"))
        self.assertIsNone(llm.parse_critic_response("{ no close"))
        self.assertIsNone(llm.parse_critic_response("}{"))
        self.assertIsNone(llm.parse_critic_response("{bad json}"))
        self.assertIsNone(llm.parse_critic_response("[1,2]"))  # not a dict

    def test_returns_none_for_bad_fields(self):
        self.assertIsNone(llm.parse_critic_response('{"fixated":"yes","confidence":0.9}'))
        self.assertIsNone(llm.parse_critic_response('{"fixated":true,"confidence":"high"}'))
        self.assertIsNone(llm.parse_critic_response('{"fixated":true,"confidence":true}'))  # bool not number
        self.assertIsNone(llm.parse_critic_response('{"fixated":true,"confidence":1.5}'))
        self.assertIsNone(llm.parse_critic_response('{"fixated":true,"confidence":-0.1}'))

    def test_parses_valid_with_surrounding_text(self):
        self.assertEqual(
            llm.parse_critic_response('{"fixated":true,"confidence":0.8}'),
            {"fixated": True, "confidence": 0.8},
        )
        self.assertEqual(
            llm.parse_critic_response('x {"fixated":false,"confidence":0} y'),
            {"fixated": False, "confidence": 0.0},
        )


class BuildGenerationPromptTests(unittest.TestCase):
    def test_persona_optional(self):
        self.assertNotIn("PERSONA", llm.build_generation_prompt(SIGNAL, CONTEXT)["system"])
        withp = llm.build_generation_prompt(SIGNAL, CONTEXT, "PERSONA: gothic idol")
        self.assertTrue(withp["system"].startswith("PERSONA: gothic idol"))
        self.assertIn("deploy staging server", withp["user"])


class ModerateNudgeTests(unittest.TestCase):
    def test_accepts_clean(self):
        self.assertTrue(llm.moderate_nudge("Maybe pivot to the rollout risks?"))

    def test_rejects_empty_long_and_disallowed(self):
        self.assertFalse(llm.moderate_nudge(""))
        self.assertFalse(llm.moderate_nudge("   "))
        self.assertFalse(llm.moderate_nudge("x" * (llm.MAX_NUDGE_CHARS + 1)))
        self.assertFalse(llm.moderate_nudge("see https://evil.example"))
        self.assertFalse(llm.moderate_nudge("@everyone look"))
        self.assertFalse(llm.moderate_nudge("MEDIA:/etc/passwd"))


class CreateWatcherLlmTests(unittest.TestCase):
    def test_critic_parses_and_fail_closes(self):
        layer = llm.create_watcher_llm(lambda prompt, system=None: '{"fixated":true,"confidence":0.9}')
        self.assertEqual(layer["critic"](SIGNAL, CONTEXT, ["a"]), {"fixated": True, "confidence": 0.9})
        none_layer = llm.create_watcher_llm(lambda prompt, system=None: None)
        self.assertIsNone(none_layer["critic"](SIGNAL, CONTEXT, ["a"]))

    def test_generate_trims_and_handles_empty(self):
        layer = llm.create_watcher_llm(lambda prompt, system=None: "  Pivot now.  ", "PERSONA")
        self.assertEqual(layer["generate"](SIGNAL, CONTEXT), "Pivot now.")
        self.assertIsNone(llm.create_watcher_llm(lambda p, system=None: "   ")["generate"](SIGNAL, CONTEXT))
        self.assertIsNone(llm.create_watcher_llm(lambda p, system=None: None)["generate"](SIGNAL, CONTEXT))

    def test_moderate_delegates(self):
        layer = llm.create_watcher_llm(lambda p, system=None: None)
        self.assertTrue(layer["moderate"]("clean line"))
        self.assertFalse(layer["moderate"]("@here spam"))


if __name__ == "__main__":
    unittest.main()
