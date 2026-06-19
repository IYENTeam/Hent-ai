"""Python side of the TS<->Python watcher-core parity gate.

Both openclaw/watcher-core.ts (via evaluateFixtureResult) and
hermes/watcher_core.py (via evaluate_fixture_result) are asserted against the
SAME shared fixtures in tests/fixtures/watcher-golden.json. If either core
diverges on fixated/patterns, its suite fails. Parity is scoped to the pure
core only (adapters are intentionally asymmetric).
"""

import importlib.util
import json
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_CORE_PATH = _ROOT / "hermes" / "watcher_core.py"
_FIXTURES_PATH = _ROOT / "tests" / "fixtures" / "watcher-golden.json"

_spec = importlib.util.spec_from_file_location("hent_ai_watcher_core", _CORE_PATH)
core = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(core)

with _FIXTURES_PATH.open("r", encoding="utf-8") as handle:
    FIXTURES = json.load(handle)["fixtures"]


def _agent(mid, text):
    return {"id": mid, "senderRole": "agent", "ts": core.DEFAULT_NOW, "text": text}


def _user(mid, text):
    return {"id": mid, "senderRole": "user", "ts": core.DEFAULT_NOW, "text": text}


def _signal():
    return {
        "schema": "conversation_watcher.internal_anti_fixation_signal.v1",
        "signalId": "sig-1",
        "scopeId": "channel:1",
        "fixationPattern": "stale_expression_repeated",
        "sourceMessageIds": ["a", "b"],
        "reason": "r",
        "suggestedPivot": "p",
    }


class GoldenParityTests(unittest.TestCase):
    def test_loads_shared_fixtures(self):
        self.assertGreaterEqual(len(FIXTURES), 5)

    def test_every_fixture_matches_expected(self):
        for fixture in FIXTURES:
            with self.subTest(fixture=fixture["name"]):
                result = core.evaluate_fixture_result(fixture)
                self.assertEqual(
                    result["fixated"],
                    fixture["expectedFixated"],
                    f"fixated mismatch for {fixture['name']}",
                )
                self.assertEqual(
                    sorted(result["patterns"]),
                    sorted(fixture["expectedPatterns"]),
                    f"patterns mismatch for {fixture['name']}",
                )

    def test_boundary_similarity_is_exactly_point_six(self):
        boundary = next(f for f in FIXTURES if f["name"] == "similarity_boundary_positive")
        texts = [m["text"] for m in boundary["rawMessages"] if m["senderRole"] == "agent"]
        self.assertAlmostEqual(core.max_pairwise_similarity(texts), 0.6, places=10)


class CoreUnitTests(unittest.TestCase):
    def test_tokenize_drops_stopwords_and_punctuation(self):
        self.assertEqual(core.tokenize("The Quick brown 42 the"), ["quick", "brown", "42"])
        self.assertEqual(core.tokenize("!!! ??? ..."), [])

    def test_tokenize_handles_korean(self):
        # Contiguous Hangul runs are single tokens (no morphological splitting);
        # the "은" stop word only matches a standalone token, matching the TS
        # /[\p{L}\p{N}]+/gu tokenizer exactly.
        self.assertEqual(
            core.tokenize("배포 스테이징 서버 지금은"), ["배포", "스테이징", "서버", "지금은"]
        )
        self.assertEqual(core.tokenize("배포 스테이징 서버 은"), ["배포", "스테이징", "서버"])

    def test_infer_topic(self):
        self.assertEqual(core.infer_topic("!!!"), "conversation")
        self.assertEqual(
            core.infer_topic("deploy the staging server immediately because reasons"),
            "deploy staging server immediately",
        )

    def test_jaccard_and_approx_gte(self):
        self.assertEqual(core.jaccard([], []), 0.0)
        self.assertAlmostEqual(core.jaccard(["a", "b"], ["b", "c"]), 1 / 3, places=10)
        self.assertTrue(core.approx_gte(0.6, 0.6))
        self.assertFalse(core.approx_gte(0.59, 0.6))

    def test_stale_detection_fires_without_user_correction(self):
        msgs = [_agent("a1", "ship it now"), _agent("a2", "ship it now")]
        signals = core.detect_stale_repetition(msgs, "channel:1")
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]["fixationPattern"], "stale_expression_repeated")
        self.assertEqual(signals[0]["severity"], "high")

    def test_stale_detection_silent_on_short_history(self):
        self.assertEqual(core.detect_stale_repetition([_agent("a1", "hi")], "channel:1"), [])

    def test_gate_precedence_and_suppression_drops_delivery(self):
        audit = core.evaluate_host_policy_gate(
            {
                "runtime": "hermes",
                "signal": _signal(),
                "criticConfidence": 1.0,
                "shadowMode": True,
                "cooldownHit": True,
                "deliveryMessageId": "d1",
            }
        )
        self.assertFalse(audit["allowed"])
        self.assertEqual(audit["suppressedReason"], "shadow_mode")
        self.assertIsNone(audit["deliveryMessageId"])

    def test_gate_allows_and_passes_delivery_id(self):
        audit = core.evaluate_host_policy_gate(
            {
                "runtime": "hermes",
                "signal": _signal(),
                "criticConfidence": 0.8,
                "deliveryMessageId": "d2",
            }
        )
        self.assertTrue(audit["allowed"])
        self.assertEqual(audit["deliveryMessageId"], "d2")
        self.assertEqual(audit["cooldownKey"], "channel:1:stale_expression_repeated")

    def test_neutral_context_empty_low_confidence(self):
        ctx = core.create_neutral_conversation_context("channel:1", [])
        self.assertEqual(ctx["confidence"], 0.1)
        self.assertEqual(ctx["currentTopic"], "conversation")
        self.assertIsNone(ctx["recentUserIntent"])


if __name__ == "__main__":
    unittest.main()
