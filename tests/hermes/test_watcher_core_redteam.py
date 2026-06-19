"""Red-team / adversarial / boundary tests for hermes/watcher_core.py.

Runs under both pytest and `python3 -m unittest`.
Only this file is created; watcher_core.py is NOT modified.
"""

from __future__ import annotations

import importlib.util
import json
import math
import unittest
from pathlib import Path

# ---------------------------------------------------------------------------
# Load module under test
# ---------------------------------------------------------------------------
_CORE_PATH = Path(__file__).resolve().parents[2] / "hermes" / "watcher_core.py"
_spec = importlib.util.spec_from_file_location("hermes_watcher_core", _CORE_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

tokenize = _mod.tokenize
infer_topic = _mod.infer_topic
similarity = _mod.similarity
max_pairwise_similarity = _mod.max_pairwise_similarity
jaccard = _mod.jaccard
bigrams = _mod.bigrams
trailing_topic_run = _mod.trailing_topic_run
approx_gte = _mod.approx_gte
compact = _mod.compact
has_any = _mod.has_any
latest_instruction = _mod.latest_instruction
check = _mod.check
create_neutral_conversation_context = _mod.create_neutral_conversation_context
detect_stale_repetition = _mod.detect_stale_repetition
detect_correction_driven_fixation = _mod.detect_correction_driven_fixation
evaluate_fixation = _mod.evaluate_fixation
plan_external_nudge = _mod.plan_external_nudge
evaluate_host_policy_gate = _mod.evaluate_host_policy_gate
evaluate_fixture_result = _mod.evaluate_fixture_result

STOP_WORDS = _mod.STOP_WORDS
SIMILARITY_EPSILON = _mod.SIMILARITY_EPSILON
DEFAULT_WINDOW_N = _mod.DEFAULT_WINDOW_N

_GOLDEN_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "watcher-golden.json"
GOLDEN = json.loads(_GOLDEN_PATH.read_text())


def _msg(id_: str, role: str, text: str) -> dict:
    return {"id": id_, "senderRole": role, "ts": "2026-06-16T00:00:00.000Z", "text": text}


# ===========================================================================
# 1. tokenize
# ===========================================================================
class TestTokenize(unittest.TestCase):

    def test_empty_string(self):
        self.assertEqual(tokenize(""), [])

    def test_all_stop_words(self):
        # Every token is a stop word – must return empty list
        self.assertEqual(tokenize("the a an and or but if"), [])

    def test_punctuation_only(self):
        # No letter/number runs
        self.assertEqual(tokenize("!!! ??? --- ..."), [])

    def test_unicode_emoji_excluded(self):
        # Emoji are not \p{L}\p{N}; only the real words survive
        result = tokenize("hello 😊 world 🎉")
        self.assertEqual(result, ["hello", "world"])

    def test_korean_particles_filtered(self):
        # "은", "는", "이", "가" are stop words; 사랑 and 행복 are not
        result = tokenize("사랑은 행복이")
        # "사랑은" is ONE token (no space), not filtered; "행복이" is also one token
        # Only if particles appear as standalone tokens are they filtered
        result_spaced = tokenize("사랑 은 행복 이")
        self.assertNotIn("은", result_spaced)
        self.assertNotIn("이", result_spaced)
        self.assertIn("사랑", result_spaced)
        self.assertIn("행복", result_spaced)

    def test_numbers_kept(self):
        result = tokenize("value 42 ok")
        self.assertIn("42", result)
        self.assertIn("value", result)
        self.assertIn("ok", result)

    def test_underscore_excluded(self):
        # "hello_world" → Python [^\W_]+ splits on underscore
        result = tokenize("hello_world foo")
        self.assertNotIn("hello_world", result)
        self.assertIn("hello", result)
        self.assertIn("world", result)

    def test_very_long_input(self):
        # 10,000-char repeated word – must not crash and must return tokens
        long_text = ("repeated " * 5000).strip()
        result = tokenize(long_text)
        self.assertGreater(len(result), 0)
        self.assertTrue(all(t == "repeated" for t in result))

    def test_mixed_script(self):
        result = tokenize("hello café 안녕 world")
        # All are non-stop unicode letter sequences
        self.assertIn("hello", result)
        self.assertIn("café", result)
        self.assertIn("안녕", result)
        self.assertIn("world", result)


# ===========================================================================
# 2. infer_topic
# ===========================================================================
class TestInferTopic(unittest.TestCase):

    def test_empty_returns_conversation(self):
        self.assertEqual(infer_topic(""), "conversation")

    def test_all_stop_words_returns_conversation(self):
        self.assertEqual(infer_topic("the a an and or but"), "conversation")

    def test_punctuation_only_returns_conversation(self):
        self.assertEqual(infer_topic("!!! ??? ---"), "conversation")

    def test_truncates_to_four_tokens(self):
        result = infer_topic("alpha beta gamma delta epsilon zeta")
        # Only first 4 non-stop tokens
        self.assertEqual(result, "alpha beta gamma delta")

    def test_fewer_than_four_tokens_ok(self):
        result = infer_topic("hello world")
        self.assertEqual(result, "hello world")

    def test_very_long_input_stable(self):
        long_text = "unique " + ("padding " * 2000)
        result = infer_topic(long_text)
        self.assertTrue(result.startswith("unique"))


# ===========================================================================
# 3. similarity (symmetry, determinism, boundary)
# ===========================================================================
class TestSimilarity(unittest.TestCase):

    def test_symmetry(self):
        a = "the quick brown fox jumps"
        b = "fox jumps high over wall quickly"
        self.assertAlmostEqual(similarity(a, b), similarity(b, a), places=12)

    def test_determinism(self):
        text = "deploy staging server right away before lunch"
        s1 = similarity(text, text)
        s2 = similarity(text, text)
        self.assertEqual(s1, s2)

    def test_identical_texts_similarity_one(self):
        t = "hello world alpha beta"
        self.assertAlmostEqual(similarity(t, t), 1.0, places=12)

    def test_both_empty(self):
        # Two empty texts → both token lists empty → jaccard([], []) = 0
        self.assertEqual(similarity("", ""), 0.0)

    def test_one_empty(self):
        self.assertEqual(similarity("hello world", ""), 0.0)
        self.assertEqual(similarity("", "hello world"), 0.0)

    def test_exactly_0_6_fires(self):
        # From golden fixture: 3 shared of 5 union tokens = 0.6
        # alpha beta gamma  (3 tokens, no stop words)
        # alpha beta gamma delta epsilon (5 tokens)
        # Jaccard = 3/5 = 0.6
        sim = similarity("alpha beta gamma", "alpha beta gamma delta epsilon")
        self.assertTrue(approx_gte(sim, 0.6), f"Expected sim>=0.6, got {sim}")

    def test_just_below_0_6_does_not_fire(self):
        # 3 shared of 6 union = 0.5 < 0.6
        # bigrams: shared=2, union=5 → 0.4; max=0.5 still < 0.6
        sim = similarity(
            "alpha beta gamma",
            "alpha beta gamma delta epsilon zeta",
        )
        self.assertFalse(approx_gte(sim, 0.6), f"Expected sim<0.6, got {sim}")

    def test_very_long_texts_no_crash(self):
        a = " ".join(f"word{i}" for i in range(500))
        b = " ".join(f"word{i}" for i in range(250, 750))
        result = similarity(a, b)
        self.assertGreaterEqual(result, 0.0)
        self.assertLessEqual(result, 1.0)


# ===========================================================================
# 4. jaccard
# ===========================================================================
class TestJaccard(unittest.TestCase):

    def test_both_empty(self):
        self.assertEqual(jaccard([], []), 0.0)

    def test_one_empty(self):
        self.assertEqual(jaccard(["a", "b"], []), 0.0)
        self.assertEqual(jaccard([], ["a", "b"]), 0.0)

    def test_identical(self):
        self.assertAlmostEqual(jaccard(["x", "y"], ["x", "y"]), 1.0, places=12)

    def test_disjoint(self):
        self.assertEqual(jaccard(["a", "b"], ["c", "d"]), 0.0)

    def test_deduplication(self):
        # jaccard uses sets – duplicates must be collapsed
        self.assertAlmostEqual(
            jaccard(["a", "a", "b"], ["a", "b", "b"]),
            jaccard(["a", "b"], ["a", "b"]),
            places=12,
        )

    def test_partial_overlap(self):
        result = jaccard(["a", "b", "c"], ["b", "c", "d"])
        # intersection={b,c}=2, union={a,b,c,d}=4 → 0.5
        self.assertAlmostEqual(result, 0.5, places=12)


# ===========================================================================
# 5. bigrams
# ===========================================================================
class TestBigrams(unittest.TestCase):

    def test_empty(self):
        self.assertEqual(bigrams([]), [])

    def test_single_token(self):
        self.assertEqual(bigrams(["hello"]), [])

    def test_two_tokens(self):
        self.assertEqual(bigrams(["hello", "world"]), ["hello world"])

    def test_three_tokens(self):
        self.assertEqual(bigrams(["a", "b", "c"]), ["a b", "b c"])


# ===========================================================================
# 6. approx_gte
# ===========================================================================
class TestApproxGte(unittest.TestCase):

    def test_exactly_threshold(self):
        self.assertTrue(approx_gte(0.6, 0.6))

    def test_one_epsilon_below_threshold(self):
        # value = threshold - epsilon/2 → should still be >= threshold - epsilon
        self.assertTrue(approx_gte(0.6 - SIMILARITY_EPSILON / 2, 0.6))

    def test_clearly_below_threshold(self):
        self.assertFalse(approx_gte(0.5, 0.6))

    def test_above_threshold(self):
        self.assertTrue(approx_gte(0.7, 0.6))

    def test_zero_comparison(self):
        self.assertTrue(approx_gte(0.0, 0.0))
        self.assertFalse(approx_gte(-1e-8, 0.0))


# ===========================================================================
# 7. compact
# ===========================================================================
class TestCompact(unittest.TestCase):

    def test_short_text_unchanged(self):
        self.assertEqual(compact("hello world"), "hello world")

    def test_whitespace_normalized(self):
        self.assertEqual(compact("hello   world\n\tfoo"), "hello world foo")

    def test_truncation_appends_ellipsis(self):
        result = compact("a" * 300, 220)
        self.assertEqual(len(result), 220)
        self.assertTrue(result.endswith("…"))

    def test_exactly_max_len_not_truncated(self):
        text = "x" * 220
        result = compact(text, 220)
        self.assertEqual(result, text)
        self.assertFalse(result.endswith("…"))

    def test_max_len_plus_one_truncated(self):
        text = "x" * 221
        result = compact(text, 220)
        self.assertTrue(result.endswith("…"))
        self.assertEqual(len(result), 220)

    def test_empty_string(self):
        self.assertEqual(compact(""), "")


# ===========================================================================
# 8. has_any
# ===========================================================================
class TestHasAny(unittest.TestCase):

    def test_empty_needles(self):
        self.assertFalse(has_any("hello world", []))

    def test_case_insensitive(self):
        self.assertTrue(has_any("Hello World", ["hello"]))
        self.assertTrue(has_any("STOP talking", ["stop"]))

    def test_empty_text(self):
        self.assertFalse(has_any("", ["hello"]))

    def test_partial_match_inside_word(self):
        self.assertTrue(has_any("stopped", ["stop"]))


# ===========================================================================
# 9. trailing_topic_run
# ===========================================================================
class TestTrailingTopicRun(unittest.TestCase):

    def test_empty(self):
        self.assertEqual(trailing_topic_run([]), 0)

    def test_single(self):
        self.assertEqual(trailing_topic_run(["foo"]), 1)

    def test_all_same(self):
        self.assertEqual(trailing_topic_run(["foo", "foo", "foo"]), 3)

    def test_trailing_same_only(self):
        self.assertEqual(trailing_topic_run(["a", "b", "c", "c"]), 2)

    def test_all_different(self):
        self.assertEqual(trailing_topic_run(["a", "b", "c"]), 1)

    def test_change_resets_run(self):
        # Only the trailing run counts
        self.assertEqual(trailing_topic_run(["x", "x", "y", "x", "x", "x"]), 3)


# ===========================================================================
# 10. latest_instruction
# ===========================================================================
class TestLatestInstruction(unittest.TestCase):

    def test_no_keyword_returns_none(self):
        self.assertIsNone(latest_instruction("let us keep going with deployment"))

    def test_stop_keyword(self):
        result = latest_instruction("stop doing that please")
        self.assertIsNotNone(result)

    def test_dont_keyword(self):
        self.assertIsNotNone(latest_instruction("don't repeat yourself"))

    def test_instead_keyword(self):
        self.assertIsNotNone(latest_instruction("instead focus on billing"))

    def test_korean_keyword_그만(self):
        self.assertIsNotNone(latest_instruction("그만해 제발"))

    def test_korean_keyword_말고(self):
        self.assertIsNotNone(latest_instruction("그것 말고 이것"))

    def test_truncates_to_160(self):
        long = "stop " + ("x" * 300)
        result = latest_instruction(long)
        self.assertIsNotNone(result)
        self.assertLessEqual(len(result), 160)

    def test_empty_string_returns_none(self):
        self.assertIsNone(latest_instruction(""))


# ===========================================================================
# 11. detect_stale_repetition – window bound and boundary
# ===========================================================================
class TestDetectStaleRepetition(unittest.TestCase):

    def _make_agent(self, i: int, text: str) -> dict:
        return _msg(f"a{i}", "agent", text)

    def _make_user(self, i: int) -> dict:
        return _msg(f"u{i}", "user", "ok")

    def test_window_bound_n8_on_huge_transcript(self):
        # 30 agent messages: first 22 are identical (should be outside window).
        # Last 8 are genuinely different topics with near-zero pairwise similarity.
        # Each text uses a completely disjoint vocabulary → pairwise sim = 0.
        repeated = "deploy staging server immediately"
        varied = [
            "weather forecast rain tomorrow",
            "stock market crash recovery",
            "recipe pasta dinner cooking",
            "sports basketball championship game",
            "music album release concert",
            "travel destination beach vacation",
            "technology hardware processor speed",
            "astronomy telescope galaxy observation",
        ]
        messages = []
        for i in range(22):
            messages.append(self._make_agent(i, repeated))
            messages.append(self._make_user(i))
        for i, v in enumerate(varied):
            messages.append(self._make_agent(100 + i, v))
        signals = detect_stale_repetition(messages, "scope:1", {"windowN": 8})
        self.assertEqual(signals, [], "Window should exclude old repeated msgs; no fixation expected")


    def test_window_last_8_fire_even_in_long_transcript(self):
        # Long transcript, but last 8 agent messages are all identical → must fire
        old_varied = [
            _msg(f"a{i}", "agent", f"unique content item {i} totally different")
            for i in range(20)
        ]
        repeated_text = "we should ship now immediately today"
        last_8 = [_msg(f"b{i}", "agent", repeated_text) for i in range(8)]
        messages = old_varied + last_8
        signals = detect_stale_repetition(messages, "scope:2", {"windowN": 8})
        self.assertGreater(len(signals), 0, "Last 8 identical agent msgs must fire")

    def test_similarity_just_below_0_6_does_not_fire(self):
        # 3/6 = 0.5 < 0.6; bigrams also below. No persistence K=3 same topic.
        a = "alpha beta gamma"
        b = "alpha beta gamma delta epsilon zeta"
        c = "zeta delta epsilon totally unrelated"
        messages = [
            _msg("m1", "agent", a),
            _msg("m2", "agent", b),
            _msg("m3", "agent", c),
        ]
        signals = detect_stale_repetition(messages, "scope:3")
        # None should be stale (sim=0.5, no persistence)
        self.assertEqual(signals, [])

    def test_exactly_0_6_fires(self):
        # From the golden fixture: 3/5 = 0.6
        a = "alpha beta gamma"
        b = "alpha beta gamma delta epsilon"
        messages = [_msg("m1", "agent", a), _msg("m2", "agent", b)]
        signals = detect_stale_repetition(messages, "scope:4")
        self.assertGreater(len(signals), 0)
        self.assertEqual(signals[0]["fixationPattern"], "stale_expression_repeated")

    def test_single_agent_message_no_signal(self):
        messages = [_msg("m1", "agent", "hello world")]
        self.assertEqual(detect_stale_repetition(messages, "scope:5"), [])

    def test_only_user_messages_no_signal(self):
        messages = [_msg(f"u{i}", "user", "same text again") for i in range(5)]
        self.assertEqual(detect_stale_repetition(messages, "scope:6"), [])

    def test_persistence_k_fires_on_moderate_similarity(self):
        # Same topic (infer_topic) repeated >= persistenceK times, sim >= floor=0.4
        # Use texts with same leading tokens → same infer_topic, moderate similarity
        topic_text = "billing bug issue"
        msgs = [_msg(f"m{i}", "agent", topic_text) for i in range(3)]
        signals = detect_stale_repetition(msgs, "scope:7", {"persistenceK": 3})
        self.assertGreater(len(signals), 0)

    def test_signal_schema_field_present(self):
        a = "alpha beta gamma"
        b = "alpha beta gamma delta epsilon"
        msgs = [_msg("m1", "agent", a), _msg("m2", "agent", b)]
        signals = detect_stale_repetition(msgs, "scope:8")
        self.assertTrue(len(signals) > 0)
        self.assertEqual(
            signals[0]["schema"],
            "conversation_watcher.internal_anti_fixation_signal.v1",
        )


# ===========================================================================
# 12. detect_correction_driven_fixation
# ===========================================================================
class TestDetectCorrectionDrivenFixation(unittest.TestCase):

    def test_golden_positive(self):
        # From correction_driven_positive fixture
        msgs = [
            _msg("m1", "agent", "should deploy staging server right away before lunch"),
            _msg("m2", "user", "stop, focus on the billing bug instead"),
            _msg("m3", "agent", "should deploy staging server because priority today honestly"),
        ]
        signals = detect_correction_driven_fixation(msgs, "scope:c1")
        self.assertGreater(len(signals), 0)
        self.assertEqual(signals[0]["fixationPattern"], "new_context_ignored_previous_frame_repeated")

    def test_no_correction_no_signal(self):
        # User doesn't use any instruction keyword → no signal
        msgs = [
            _msg("m1", "agent", "deploy staging today"),
            _msg("m2", "user", "sure that sounds fine"),
            _msg("m3", "agent", "deploy staging today confirmed"),
        ]
        signals = detect_correction_driven_fixation(msgs, "scope:c2")
        self.assertEqual(signals, [])

    def test_correction_but_agent_pivots_no_signal(self):
        # Agent genuinely pivots after user correction → infer_topic differs
        msgs = [
            _msg("m1", "agent", "deploy staging server right away immediately"),
            _msg("m2", "user", "stop, focus on billing bug refund"),
            _msg("m3", "agent", "billing bug refund needs investigation"),
        ]
        signals = detect_correction_driven_fixation(msgs, "scope:c3")
        self.assertEqual(signals, [])

    def test_insufficient_messages(self):
        # Need at least 3 messages
        msgs = [
            _msg("m1", "agent", "topic one"),
            _msg("m2", "user", "stop"),
        ]
        self.assertEqual(detect_correction_driven_fixation(msgs, "scope:c4"), [])

    def test_unicode_korean_correction_keyword(self):
        # Korean "그만" should trigger correction detection.
        # Both agent msgs must share the same first-4-token frame so
        # repeated_frame=True; the user correction uses "그만" keyword.
        msgs = [
            _msg("m1", "agent", "서버 배포 지금 당장 하겠습니다"),
            _msg("m2", "user", "그만, 청구 버그 먼저 처리해"),
            _msg("m3", "agent", "서버 배포 지금 당장 확인합니다"),
        ]
        signals = detect_correction_driven_fixation(msgs, "scope:c5")
        self.assertGreater(len(signals), 0)


# ===========================================================================
# 13. evaluate_host_policy_gate – suppression precedence + deliveryMessageId
# ===========================================================================
class TestEvaluateHostPolicyGate(unittest.TestCase):

    def _base_signal(self):
        return {
            "schema": "conversation_watcher.internal_anti_fixation_signal.v1",
            "signalId": "sig-test-001",
            "scopeId": "scope:gate",
            "fixationPattern": "stale_expression_repeated",
            "sourceMessageIds": ["m1", "m2"],
            "reason": "test reason",
            "suggestedPivot": "pivot",
        }

    def _base_input(self, **kwargs):
        return {
            "runtime": "hermes",
            "signal": self._base_signal(),
            "deliveryMessageId": "deliver-msg-1",
            **kwargs,
        }

    def test_allowed_has_delivery_message_id(self):
        result = evaluate_host_policy_gate(self._base_input())
        self.assertTrue(result["allowed"])
        self.assertEqual(result["deliveryMessageId"], "deliver-msg-1")

    def test_suppressed_never_leaks_delivery_message_id(self):
        # All suppression paths must null out deliveryMessageId
        for flag, val in [
            ("shadowMode", True),
            ("cooldownHit", True),
            ("duplicateHit", True),
            ("privacyRisk", True),
        ]:
            with self.subTest(flag=flag):
                result = evaluate_host_policy_gate(self._base_input(**{flag: val}))
                self.assertFalse(result["allowed"])
                self.assertIsNone(result["deliveryMessageId"], f"{flag}: deliveryMessageId must be None when suppressed")

    def test_shadow_mode_wins_over_cooldown(self):
        # Both shadowMode and cooldownHit → shadow_mode takes precedence
        result = evaluate_host_policy_gate(
            self._base_input(shadowMode=True, cooldownHit=True)
        )
        self.assertEqual(result["suppressedReason"], "shadow_mode")

    def test_shadow_mode_wins_over_all(self):
        result = evaluate_host_policy_gate(
            self._base_input(
                shadowMode=True, cooldownHit=True, duplicateHit=True,
                privacyRisk=True, crossThreadRisk=True,
            )
        )
        self.assertEqual(result["suppressedReason"], "shadow_mode")

    def test_cooldown_wins_over_duplicate(self):
        result = evaluate_host_policy_gate(
            self._base_input(cooldownHit=True, duplicateHit=True)
        )
        self.assertEqual(result["suppressedReason"], "cooldown")

    def test_duplicate_wins_over_privacy(self):
        result = evaluate_host_policy_gate(
            self._base_input(duplicateHit=True, privacyRisk=True)
        )
        self.assertEqual(result["suppressedReason"], "duplicate")

    def test_privacy_wins_over_thread_mismatch(self):
        result = evaluate_host_policy_gate(
            self._base_input(
                privacyRisk=True,
                sourceThreadId="thread-a",
                targetThreadId="thread-b",
            )
        )
        self.assertEqual(result["suppressedReason"], "privacy")

    def test_thread_mismatch_suppresses(self):
        result = evaluate_host_policy_gate(
            self._base_input(sourceThreadId="thread-a", targetThreadId="thread-b")
        )
        self.assertFalse(result["allowed"])
        self.assertEqual(result["suppressedReason"], "thread_mismatch")

    def test_cross_thread_risk_suppresses(self):
        result = evaluate_host_policy_gate(self._base_input(crossThreadRisk=True))
        self.assertFalse(result["allowed"])
        self.assertEqual(result["suppressedReason"], "thread_mismatch")

    def test_allowed_result_schema(self):
        result = evaluate_host_policy_gate(self._base_input())
        self.assertEqual(result["schema"], "conversation_watcher.host_policy_gate_audit.v1")
        self.assertIn("cooldownKey", result)
        self.assertIn("duplicateCheck", result)
        self.assertIn("privacyCheck", result)
        self.assertIn("threadCheck", result)


# ===========================================================================
# 14. create_neutral_conversation_context
# ===========================================================================
class TestCreateNeutralConversationContext(unittest.TestCase):

    def test_empty_messages(self):
        result = create_neutral_conversation_context("scope:ctx1", [])
        self.assertEqual(result["currentTopic"], "conversation")
        self.assertIsNone(result["recentUserIntent"])
        self.assertEqual(result["confidence"], 0.1)

    def test_open_questions_english(self):
        msgs = [_msg("m1", "user", "What is the status?")]
        result = create_neutral_conversation_context("scope:ctx2", msgs)
        self.assertGreater(len(result["openQuestions"]), 0)

    def test_open_questions_korean(self):
        msgs = [_msg("m1", "user", "어떻게 할까")]
        result = create_neutral_conversation_context("scope:ctx3", msgs)
        self.assertGreater(len(result["openQuestions"]), 0)

    def test_no_open_question_for_statement(self):
        msgs = [_msg("m1", "user", "Deploy the server now")]
        result = create_neutral_conversation_context("scope:ctx4", msgs)
        self.assertEqual(result["openQuestions"], [])

    def test_discontinuity_detected(self):
        msgs = [
            _msg("m1", "user", "deploy staging server today"),
            _msg("m2", "agent", "ok"),
            _msg("m3", "user", "billing bug refund credit"),
        ]
        result = create_neutral_conversation_context("scope:ctx5", msgs)
        self.assertGreater(len(result["contextDiscontinuities"]), 0)

    def test_high_confidence_with_messages(self):
        msgs = [_msg("m1", "user", "hello")]
        result = create_neutral_conversation_context("scope:ctx6", msgs)
        self.assertAlmostEqual(result["confidence"], 0.82, places=5)

    def test_source_message_ids_preserved(self):
        msgs = [
            _msg("x1", "user", "hello"),
            _msg("x2", "agent", "world"),
        ]
        result = create_neutral_conversation_context("scope:ctx7", msgs)
        self.assertIn("x1", result["sourceMessageIds"])
        self.assertIn("x2", result["sourceMessageIds"])


# ===========================================================================
# 15. max_pairwise_similarity
# ===========================================================================
class TestMaxPairwiseSimilarity(unittest.TestCase):

    def test_empty_list(self):
        self.assertEqual(max_pairwise_similarity([]), 0.0)

    def test_single_text(self):
        self.assertEqual(max_pairwise_similarity(["hello world"]), 0.0)

    def test_all_identical(self):
        self.assertAlmostEqual(
            max_pairwise_similarity(["foo bar", "foo bar", "foo bar"]), 1.0, places=12
        )

    def test_all_disjoint(self):
        result = max_pairwise_similarity(["alpha", "beta", "gamma"])
        self.assertEqual(result, 0.0)

    def test_large_list_no_crash(self):
        texts = [f"topic concept idea number {i} unique content" for i in range(50)]
        result = max_pairwise_similarity(texts)
        self.assertGreaterEqual(result, 0.0)
        self.assertLessEqual(result, 1.0)


# ===========================================================================
# 16. Golden fixture parity (evaluate_fixture_result)
# ===========================================================================
class TestGoldenFixtures(unittest.TestCase):

    def _run_fixture(self, fixture: dict):
        result = evaluate_fixture_result(fixture)
        self.assertEqual(
            result["fixated"],
            fixture["expectedFixated"],
            f"{fixture['name']}: fixated mismatch",
        )
        self.assertEqual(
            sorted(result["patterns"]),
            sorted(fixture["expectedPatterns"]),
            f"{fixture['name']}: patterns mismatch",
        )

    def test_all_golden_fixtures(self):
        fixtures = GOLDEN["fixtures"]
        self.assertGreater(len(fixtures), 0)
        for fixture in fixtures:
            with self.subTest(name=fixture["name"]):
                self._run_fixture(fixture)

    def test_golden_self_repetition_positive(self):
        f = next(x for x in GOLDEN["fixtures"] if x["name"] == "self_repetition_positive")
        self._run_fixture(f)

    def test_golden_legit_elaboration_negative(self):
        f = next(x for x in GOLDEN["fixtures"] if x["name"] == "legit_elaboration_negative")
        self._run_fixture(f)

    def test_golden_similarity_boundary_positive(self):
        f = next(x for x in GOLDEN["fixtures"] if x["name"] == "similarity_boundary_positive")
        self._run_fixture(f)

    def test_golden_correction_driven_positive(self):
        f = next(x for x in GOLDEN["fixtures"] if x["name"] == "correction_driven_positive")
        self._run_fixture(f)


# ===========================================================================
# 17. Property: determinism across repeated calls
# ===========================================================================
class TestDeterminism(unittest.TestCase):

    def test_evaluate_fixation_deterministic(self):
        msgs = [
            _msg("m1", "agent", "I think we should ship the release today for sure."),
            _msg("m2", "user", "ok"),
            _msg("m3", "agent", "I think we should ship the release today for sure."),
            _msg("m4", "user", "hmm"),
            _msg("m5", "agent", "I think we should ship the release today for sure."),
        ]
        r1 = evaluate_fixation(msgs, "scope:det1")
        r2 = evaluate_fixation(msgs, "scope:det1")
        self.assertEqual(r1, r2)

    def test_similarity_symmetry_exhaustive(self):
        pairs = [
            ("hello world foo", "foo hello bar"),
            ("alpha beta gamma", "gamma delta epsilon"),
            ("deploy server staging", "staging deploy test"),
            ("", "something"),
            ("", ""),
        ]
        for a, b in pairs:
            with self.subTest(a=a, b=b):
                self.assertAlmostEqual(similarity(a, b), similarity(b, a), places=12)


# ===========================================================================
# 18. plan_external_nudge
# ===========================================================================
class TestPlanExternalNudge(unittest.TestCase):

    def _signal(self):
        return {
            "signalId": "sig-001",
            "scopeId": "scope:nudge1",
            "reason": "fixated on deployment",
            "suggestedPivot": "pivot to billing",
            "sourceMessageIds": ["m1", "m2"],
        }

    def test_basic_shape(self):
        result = plan_external_nudge("hermes", self._signal(), "Try something new.")
        self.assertEqual(result["schema"], "conversation_watcher.external_nudge.v1")
        self.assertEqual(result["nudgeId"], "nudge-sig-001")
        self.assertEqual(result["text"], "Try something new.")
        self.assertEqual(result["identityDisclosure"], "agent_explicit")
        self.assertEqual(result["internalSignalId"], "sig-001")

    def test_target_merged(self):
        result = plan_external_nudge(
            "openclaw",
            self._signal(),
            "nudge text",
            {"channel": "ch-123", "threadId": "t-456"},
        )
        self.assertEqual(result["target"]["runtime"], "openclaw")
        self.assertEqual(result["target"]["channel"], "ch-123")
        self.assertEqual(result["target"]["threadId"], "t-456")

    def test_no_target_sets_runtime_only(self):
        result = plan_external_nudge("hermes", self._signal(), "text")
        self.assertEqual(result["target"], {"runtime": "hermes"})


if __name__ == "__main__":
    unittest.main()
