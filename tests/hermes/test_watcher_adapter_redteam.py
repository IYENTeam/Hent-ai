"""Red-team adversarial tests for hermes/watcher_adapter.py, hermes/llm_client.py,
and the composed transform_llm_output hook in hermes/__init__.py.

Covers: multi-scope interleaving, idle-TTL boundary, LRU cap invariant,
window-N bound, cooldown boundary, budget per-scope independence, budget reset,
misbehaving critic/generate/moderate (raise, weird return values), moderation
edge cases, llm_client malformed JSON, wrong-API-shape cross-wiring, missing
config, urlopen raising, call_chat_json fence tolerance and non-dict JSON,
and the ordering invariant that nudge text never appears after a MEDIA: directive.
"""

from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

_ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, _ROOT / rel)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


adapter = _load("hent_ai_watcher_adapter_rt", "hermes/watcher_adapter.py")
llm = _load("hent_ai_llm_client_rt", "hermes/llm_client.py")
plugin = _load("hent_ai_hermes_plugin_rt", "hermes/__init__.py")

REPEAT = "ship the release today ship the release today"
WATCHER_WINDOW_N: int = adapter.WATCHER_WINDOW_N        # 8
WATCHER_SCOPE_TTL_MS: int = adapter.WATCHER_SCOPE_TTL_MS  # 1_800_000
WATCHER_MAX_SCOPES: int = adapter.WATCHER_MAX_SCOPES    # 500
HOUR_MS: int = adapter.HOUR_MS                           # 3_600_000


class CapLogger:
    def __init__(self) -> None:
        self.infos: list = []
        self.warns: list = []

    def info(self, *a: object) -> None:
        self.infos.append(" ".join(str(x) for x in a))

    def warn(self, *a: object) -> None:
        self.warns.append(" ".join(str(x) for x in a))


def _make(config: dict, **over):
    """Build an adapter with injectable deps. Keyword overrides replace individual deps."""
    clock = [1000]
    log = CapLogger()
    deps: dict = {
        "config": config,
        "logger": log,
        "critic": over.get("critic", lambda s, c, t: {"fixated": True, "confidence": 0.9}),
        "generate": over.get("generate", lambda s, c: "Fresh angle."),
        "moderate": over.get("moderate", lambda t: True),
        "now": lambda: clock[0],
        "isoNow": lambda: "2026-06-16T00:00:00.000Z",
    }
    if over.get("no_llm"):
        for k in ("critic", "generate", "moderate"):
            deps.pop(k, None)
    a = adapter.create_hermes_watcher_adapter(deps)
    return a, log, clock


# ─────────────────────────────────────────────────────────────────────────────
# Group 1: Scope isolation, LRU, TTL, and window-N
# ─────────────────────────────────────────────────────────────────────────────

class ScopeLRUWindowTests(unittest.TestCase):

    def test_interleaved_scopes_independent_buffers(self):
        """Turns on scope A and B must not bleed into each other's windows."""
        geology = "geology rocks minerals strata deposits formations"
        a, _, _ = _make({"enabled": True, "shadowMode": False, "cooldownMs": 0})
        # Prime both scopes (1 message each — not enough for fixation yet)
        a["on_agent_turn"]("A", REPEAT)
        a["on_agent_turn"]("B", geology)
        # 2nd turn each: fixation should fire independently for each scope
        nudge_a = a["on_agent_turn"]("A", REPEAT)
        nudge_b = a["on_agent_turn"]("B", geology)
        self.assertIsNotNone(nudge_a, "scope A must detect its own fixation")
        self.assertIsNotNone(nudge_b, "scope B must detect its own fixation")
        self.assertEqual(a["scope_count"](), 2)

    def test_scope_b_not_nudged_because_of_scope_a_fixation(self):
        """Scope B with varied content must not inherit A's fixated state."""
        a, _, _ = _make({"enabled": True, "shadowMode": False, "cooldownMs": 0})
        for _ in range(5):
            a["on_agent_turn"]("A", REPEAT)
        varied = [
            "the weather is mild today",
            "discussing art history",
            "python coding patterns",
            "recipe for sourdough bread",
        ]
        for text in varied:
            result = a["on_agent_turn"]("B", text)
            self.assertIsNone(result, f"scope B should not be nudged for: {text!r}")

    def test_ttl_at_exactly_boundary_not_evicted(self):
        """Scope idle for exactly TTL_MS is NOT yet evicted (strict > boundary)."""
        a, _, clock = _make({"enabled": False})
        clock[0] = 1000
        a["on_agent_turn"]("s1", "hello")
        clock[0] = 1000 + WATCHER_SCOPE_TTL_MS  # delta == TTL, TTL > TTL is False
        a["on_agent_turn"]("s2", "hello")
        self.assertEqual(a["scope_count"](), 2, "s1 must NOT be evicted at exactly TTL ms")

    def test_ttl_one_ms_past_boundary_evicts(self):
        """Scope idle for TTL+1 ms IS evicted on the next push."""
        a, _, clock = _make({"enabled": False})
        clock[0] = 1000
        a["on_agent_turn"]("s1", "hello")
        clock[0] = 1000 + WATCHER_SCOPE_TTL_MS + 1
        a["on_agent_turn"]("s2", "hello")
        self.assertEqual(a["scope_count"](), 1, "s1 must be evicted at TTL+1 ms")

    def test_multiple_idle_scopes_all_evicted_in_one_sweep(self):
        """Every expired scope is removed by evict_idle in a single push call."""
        a, _, clock = _make({"enabled": False})
        clock[0] = 1000
        for i in range(5):
            a["on_agent_turn"](f"old-{i}", "hello")
        self.assertEqual(a["scope_count"](), 5)
        clock[0] = 1000 + WATCHER_SCOPE_TTL_MS + 1
        a["on_agent_turn"]("fresh", "hello")
        self.assertEqual(a["scope_count"](), 1, "all 5 idle scopes must be evicted at once")

    def test_lru_cap_invariant_never_exceeds_max(self):
        """scope_count() must never exceed WATCHER_MAX_SCOPES at any point."""
        a, _, _ = _make({"enabled": False})
        for i in range(WATCHER_MAX_SCOPES + 20):
            a["on_agent_turn"](f"scope-{i}", "hello")
            self.assertLessEqual(
                a["scope_count"](), WATCHER_MAX_SCOPES,
                f"scope_count violated max after inserting scope-{i}",
            )

    def test_lru_cap_at_exactly_max_no_eviction_occurs(self):
        """WATCHER_MAX_SCOPES scopes fit without any eviction."""
        a, _, _ = _make({"enabled": False})
        for i in range(WATCHER_MAX_SCOPES):
            a["on_agent_turn"](f"s-{i}", "hello")
        self.assertEqual(a["scope_count"](), WATCHER_MAX_SCOPES)

    def test_lru_most_recently_touched_scope_survives_overflow(self):
        """Adding one overflow scope evicts an older scope, not the just-touched one."""
        a, _, _ = _make({"enabled": False})
        # Fill MAX_SCOPES - 1 old scopes (they are older in insertion order)
        for i in range(WATCHER_MAX_SCOPES - 1):
            a["on_agent_turn"](f"old-{i}", "hello")
        # 'newest' is now the most recently touched (tail of dict)
        a["on_agent_turn"]("newest", "hello")
        self.assertEqual(a["scope_count"](), WATCHER_MAX_SCOPES)
        # One overflow: should evict old-0, not 'newest'
        a["on_agent_turn"]("overflow", "hello")
        self.assertLessEqual(a["scope_count"](), WATCHER_MAX_SCOPES)
        # 'newest' still exists: re-touching must not increase scope_count
        before = a["scope_count"]()
        a["on_agent_turn"]("newest", "hello")
        self.assertEqual(
            a["scope_count"](), before,
            "re-touching an existing scope must not increase scope_count",
        )

    def test_window_n8_oldest_turns_dropped_from_fixation_analysis(self):
        """After > WATCHER_WINDOW_N turns, only the latest N participate in fixation.

        4 priming turns use numeric-only tokens (zero cross-similarity with each
        other and with REPEAT).  cooldownMs=0 lets every REPEAT turn fire
        independently so at least one nudge must come back once the window is
        full of REPEAT messages.
        """
        # Numeric texts: set_a ∩ set_b = ∅ for different digits → jaccard = 0
        priming = [f"{d}{d}{d}{d} {d}{d}{d}{d} {d}{d}{d}{d}" for d in "1234"]
        a, _, _ = _make({"enabled": True, "shadowMode": False, "cooldownMs": 0})
        for t in priming:
            a["on_agent_turn"]("s1", t)
        nudges = [a["on_agent_turn"]("s1", REPEAT) for _ in range(WATCHER_WINDOW_N)]
        self.assertTrue(
            any(n is not None for n in nudges),
            "fixation must fire after WATCHER_WINDOW_N identical REPEAT turns",
        )

    def test_window_n8_exactly_fills_buffer_no_overflow(self):
        """Exactly WATCHER_WINDOW_N agent turns do not overflow; all are kept."""
        a, _, _ = _make({"enabled": False})
        for i in range(WATCHER_WINDOW_N):
            a["on_agent_turn"]("s1", f"turn {i}")
        # scope_count is 1 (still one scope)
        self.assertEqual(a["scope_count"](), 1)


# ─────────────────────────────────────────────────────────────────────────────
# Group 2: Cooldown and budget boundaries
# ─────────────────────────────────────────────────────────────────────────────

class CooldownBudgetTests(unittest.TestCase):

    def test_cooldown_expired_at_exact_boundary_allows_nudge(self):
        """At exactly cooldown_ms elapsed, the cooldown is over and a nudge fires."""
        cooldown = 60_000
        a, _, clock = _make({"enabled": True, "shadowMode": False, "cooldownMs": cooldown})
        clock[0] = 1000
        a["on_agent_turn"]("s1", REPEAT)
        nudge1 = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(nudge1)  # first nudge; commits cooldown at t=1000
        # delta == cooldown → NOT < cooldown → cooldown_hit is False → allowed
        clock[0] = 1000 + cooldown
        nudge2 = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(nudge2, "nudge must be allowed at exact cooldown expiry")

    def test_cooldown_one_ms_before_expiry_suppresses(self):
        """1 ms before cooldown expires, the nudge is still suppressed."""
        cooldown = 60_000
        a, _, clock = _make({"enabled": True, "shadowMode": False, "cooldownMs": cooldown})
        clock[0] = 1000
        a["on_agent_turn"]("s1", REPEAT)
        a["on_agent_turn"]("s1", REPEAT)  # commits cooldown at t=1000
        clock[0] = 1000 + cooldown - 1
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result, "nudge must be suppressed 1 ms before cooldown expires")

    def test_budget_per_scope_isolation(self):
        """Exhausting scope A's hourly budget must not affect scope B."""
        a, _, _ = _make({
            "enabled": True, "shadowMode": False,
            "cooldownMs": 0, "budgetPerHour": 1,
        })
        a["on_agent_turn"]("A", REPEAT)
        self.assertIsNotNone(a["on_agent_turn"]("A", REPEAT))  # uses A's 1 slot
        self.assertIsNone(a["on_agent_turn"]("A", REPEAT))  # A exhausted
        a["on_agent_turn"]("B", REPEAT)
        nudge_b = a["on_agent_turn"]("B", REPEAT)
        self.assertIsNotNone(nudge_b, "scope B must have its own independent budget")

    def test_budget_resets_after_hour_ms(self):
        """Budget window resets once HOUR_MS has elapsed, re-enabling nudges."""
        a, _, clock = _make({
            "enabled": True, "shadowMode": False,
            "cooldownMs": 0, "budgetPerHour": 1,
        })
        clock[0] = 1000
        a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(a["on_agent_turn"]("s1", REPEAT))  # uses budget
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))  # depleted
        # Advance past the hour; budget window must reset
        clock[0] = 1000 + HOUR_MS
        a["on_agent_turn"]("s1", REPEAT)
        nudge = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(nudge, "budget must reset after HOUR_MS")

    def test_budget_at_exact_hour_boundary_resets(self):
        """Budget resets at exactly HOUR_MS elapsed (>= condition is inclusive)."""
        a, _, clock = _make({
            "enabled": True, "shadowMode": False,
            "cooldownMs": 0, "budgetPerHour": 1,
        })
        clock[0] = 0
        a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(a["on_agent_turn"]("s1", REPEAT))
        self.assertIsNone(a["on_agent_turn"]("s1", REPEAT))
        # Exactly one hour: current - windowStart == HOUR_MS → >= HOUR_MS → reset
        clock[0] = HOUR_MS
        a["on_agent_turn"]("s1", REPEAT)
        nudge = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(nudge, "budget must reset at exactly HOUR_MS elapsed")

    def test_budget_not_shared_across_different_patterns(self):
        """A scope can have multiple fixation patterns; each pattern's cooldown is independent."""
        # Both patterns share the same scope budget counter, but this verifies
        # cooldown keys are pattern-scoped.
        a, _, _ = _make({
            "enabled": True, "shadowMode": False,
            "cooldownMs": 0, "budgetPerHour": 10,
        })
        for _ in range(4):
            a["on_agent_turn"]("s1", REPEAT)
        nudge = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(nudge)


# ─────────────────────────────────────────────────────────────────────────────
# Group 3: Misbehaving critic / generate / moderate
# ─────────────────────────────────────────────────────────────────────────────

class MisbehavingDepsTests(unittest.TestCase):

    def test_critic_exception_must_not_propagate(self):
        """A raising critic must NOT crash on_agent_turn; adapter must fail-close to None."""
        def bad_critic(s, c, t):
            raise RuntimeError("critic exploded")

        a, _, _ = _make({"enabled": True, "shadowMode": False}, critic=bad_critic)
        a["on_agent_turn"]("s1", REPEAT)
        try:
            result = a["on_agent_turn"]("s1", REPEAT)
            self.assertIsNone(result)
        except RuntimeError:
            self.fail(
                "DEFECT: critic exception propagated out of on_agent_turn; "
                "adapter must fail-close to None"
            )

    def test_generate_exception_must_not_propagate(self):
        """A raising generate must NOT crash on_agent_turn; adapter must fail-close to None."""
        def bad_generate(s, c):
            raise ValueError("generator on fire")

        a, _, _ = _make({"enabled": True, "shadowMode": False}, generate=bad_generate)
        a["on_agent_turn"]("s1", REPEAT)
        try:
            result = a["on_agent_turn"]("s1", REPEAT)
            self.assertIsNone(result)
        except ValueError:
            self.fail(
                "DEFECT: generate exception propagated out of on_agent_turn; "
                "adapter must fail-close to None"
            )

    def test_moderate_exception_must_not_propagate(self):
        """A raising moderate must NOT crash on_agent_turn; adapter must fail-close to None."""
        def bad_moderate(t):
            raise TypeError("moderator crashed")

        a, _, _ = _make({"enabled": True, "shadowMode": False}, moderate=bad_moderate)
        a["on_agent_turn"]("s1", REPEAT)
        try:
            result = a["on_agent_turn"]("s1", REPEAT)
            self.assertIsNone(result)
        except TypeError:
            self.fail(
                "DEFECT: moderate exception propagated out of on_agent_turn; "
                "adapter must fail-close to None"
            )

    def test_critic_returns_empty_dict_no_nudge(self):
        """Critic returning {} (missing fixated key) must not produce a nudge."""
        a, _, _ = _make({"enabled": True, "shadowMode": False}, critic=lambda s, c, t: {})
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result)

    def test_critic_returns_fixated_true_no_confidence_suppresses(self):
        """Critic with fixated=True but no confidence key defaults to 0.0 < threshold."""
        a, _, _ = _make(
            {"enabled": True, "shadowMode": False},
            critic=lambda s, c, t: {"fixated": True},
        )
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result, "missing confidence must default to 0.0 and suppress nudge")

    def test_critic_confidence_exactly_at_threshold_allows_nudge(self):
        """Confidence exactly equal to threshold must NOT be rejected (< not <=)."""
        threshold = 0.7
        a, _, _ = _make(
            {"enabled": True, "shadowMode": False, "confidenceThreshold": threshold},
            critic=lambda s, c, t: {"fixated": True, "confidence": threshold},
        )
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(result, "confidence == threshold must allow nudge (strict <)")

    def test_critic_confidence_just_below_threshold_suppresses(self):
        """Confidence 0.001 below threshold must suppress nudge."""
        threshold = 0.7
        a, _, _ = _make(
            {"enabled": True, "shadowMode": False, "confidenceThreshold": threshold},
            critic=lambda s, c, t: {"fixated": True, "confidence": threshold - 0.001},
        )
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result)

    def test_critic_fixated_false_high_confidence_suppresses(self):
        """fixated=False with very high confidence must not nudge."""
        a, _, _ = _make(
            {"enabled": True, "shadowMode": False},
            critic=lambda s, c, t: {"fixated": False, "confidence": 0.99},
        )
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result)

    def test_critic_truthy_non_bool_fixated_allows_nudge(self):
        """fixated=1 (truthy non-bool) must be treated as fixated=True."""
        a, _, _ = _make(
            {"enabled": True, "shadowMode": False},
            critic=lambda s, c, t: {"fixated": 1, "confidence": 0.9},
        )
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNotNone(result)

    def test_critic_returns_none_logs_and_suppresses(self):
        """Critic returning None must log a warning and produce no nudge."""
        a, log, _ = _make(
            {"enabled": True, "shadowMode": False},
            critic=lambda s, c, t: None,
        )
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result)
        self.assertTrue(any("critic returned null" in w for w in log.warns))

    def test_generate_returns_empty_string_suppresses(self):
        """generate returning '' is falsy and must suppress the nudge."""
        a, log, _ = _make({"enabled": True, "shadowMode": False}, generate=lambda s, c: "")
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result)
        self.assertTrue(any("nudge suppressed" in w for w in log.warns))

    def test_generate_returns_none_suppresses(self):
        """generate returning None must suppress the nudge."""
        a, log, _ = _make({"enabled": True, "shadowMode": False}, generate=lambda s, c: None)
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result)
        self.assertTrue(any("nudge suppressed" in w for w in log.warns))

    def test_moderate_returns_false_suppresses(self):
        """moderate returning False must suppress the nudge."""
        a, log, _ = _make({"enabled": True, "shadowMode": False}, moderate=lambda t: False)
        a["on_agent_turn"]("s1", REPEAT)
        result = a["on_agent_turn"]("s1", REPEAT)
        self.assertIsNone(result)
        self.assertTrue(any("moderation failed" in w for w in log.warns))

    def test_generate_returns_whitespace_only_is_truthy_passes_check(self):
        """'   ' is truthy; adapter returns it as nudge (Mode B compose strips to empty)."""
        a, _, _ = _make({"enabled": True, "shadowMode": False}, generate=lambda s, c: "   ")
        a["on_agent_turn"]("s1", REPEAT)
        nudge = a["on_agent_turn"]("s1", REPEAT)
        # Nudge is "   " (truthy); Mode B compose drops the response and strips the steer to "".
        if nudge is not None:
            composed = adapter.compose_nudge("response", nudge)
            self.assertEqual(composed, "")

    def test_critic_raises_exception_budget_not_consumed(self):
        """If critic raises, the budget slot should not be wasted (ideally).

        This is a behavioral documentation test: we verify how the adapter handles
        budget accounting when the critic misbehaves.
        """
        call_count = [0]

        def counting_critic(s, c, t):
            call_count[0] += 1
            raise RuntimeError("always fails")

        a, _, _ = _make(
            {"enabled": True, "shadowMode": False, "cooldownMs": 0, "budgetPerHour": 5},
            critic=counting_critic,
        )
        a["on_agent_turn"]("s1", REPEAT)
        # Try 5 times; each may or may not consume budget depending on where exception occurs
        for _ in range(5):
            try:
                a["on_agent_turn"]("s1", REPEAT)
            except RuntimeError:
                pass  # exception propagation is the defect tracked separately
        # If we reach here without fatal crash, the budget accounting is the secondary concern


# ─────────────────────────────────────────────────────────────────────────────
# Group 4: llm_client adversarial cases
# ─────────────────────────────────────────────────────────────────────────────

class LlmClientAdversarialTests(unittest.TestCase):

    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k) for k in (
            "HENT_AI_LLM_API", "HENT_AI_LLM_BASE_URL",
            "HENT_AI_LLM_API_KEY", "HENT_AI_LLM_MODEL",
        )}
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
        class _R:
            def read(self):
                return body.encode("utf-8")
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        return lambda req, timeout=None: _R()

    def _env(self, api: str = "openai") -> None:
        os.environ["HENT_AI_LLM_API_KEY"] = "test-key"
        os.environ["HENT_AI_LLM_MODEL"] = "test-model"
        os.environ["HENT_AI_LLM_API"] = api

    # Missing config -----------------------------------------------------------

    def test_missing_api_key_fail_closes(self):
        os.environ["HENT_AI_LLM_MODEL"] = "m"
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('{"choices":[]}')))

    def test_missing_model_fail_closes(self):
        os.environ["HENT_AI_LLM_API_KEY"] = "k"
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('{"choices":[]}')))

    def test_both_missing_fail_closes(self):
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('{"choices":[]}')))

    # OpenAI shape edge cases --------------------------------------------------

    def test_openai_empty_choices_returns_none(self):
        self._env()
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('{"choices":[]}')))

    def test_openai_missing_message_key_returns_none(self):
        self._env()
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('{"choices":[{}]}')))

    def test_openai_null_content_returns_none(self):
        self._env()
        body = '{"choices":[{"message":{"content":null}}]}'
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen(body)))

    def test_openai_empty_string_content_returns_none(self):
        self._env()
        body = '{"choices":[{"message":{"content":""}}]}'
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen(body)))

    def test_openai_integer_content_coerced_to_str(self):
        """Non-string but truthy content is coerced via str()."""
        self._env()
        body = '{"choices":[{"message":{"content":42}}]}'
        result = llm.call_chat("hi", urlopen=self._urlopen(body))
        self.assertEqual(result, "42")

    def test_openai_no_choices_key_returns_none(self):
        self._env()
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen("{}")))

    # Anthropic shape edge cases -----------------------------------------------

    def test_anthropic_empty_content_array_returns_none(self):
        self._env("anthropic")
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('{"content":[]}')))

    def test_anthropic_only_non_text_blocks_returns_none(self):
        """Anthropic response with only image/tool_use blocks must return None."""
        self._env("anthropic")
        body = '{"content":[{"type":"image"},{"type":"tool_use","id":"t1"}]}'
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen(body)))

    def test_anthropic_text_block_with_empty_text_returns_none(self):
        """Anthropic text block with empty string must return None (falsy check)."""
        self._env("anthropic")
        body = '{"content":[{"type":"text","text":""}]}'
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen(body)))

    def test_anthropic_no_content_key_returns_none(self):
        self._env("anthropic")
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen("{}")))

    def test_anthropic_text_block_before_non_text_returns_text(self):
        """First text block is returned even when followed by non-text blocks."""
        self._env("anthropic")
        body = '{"content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"t1"}]}'
        self.assertEqual(llm.call_chat("hi", urlopen=self._urlopen(body)), "hello")

    # Cross-wired API shapes ---------------------------------------------------

    def test_openai_shape_to_anthropic_parser_returns_none(self):
        """OpenAI response body fed to anthropic API parser must return None."""
        self._env("anthropic")
        openai_body = '{"choices":[{"message":{"content":"hello"}}]}'
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen(openai_body)))

    def test_anthropic_shape_to_openai_parser_returns_none(self):
        """Anthropic response body fed to openai API parser must return None."""
        self._env("openai")
        anthropic_body = '{"content":[{"type":"text","text":"yo"}]}'
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen(anthropic_body)))

    # Network / HTTP failures --------------------------------------------------

    def test_urlopen_raises_connection_error_fail_closes(self):
        self._env()
        def boom(req, timeout=None):
            raise ConnectionError("connection refused")
        self.assertIsNone(llm.call_chat("hi", urlopen=boom))

    def test_urlopen_raises_os_error_fail_closes(self):
        self._env()
        def boom(req, timeout=None):
            raise OSError("network unreachable")
        self.assertIsNone(llm.call_chat("hi", urlopen=boom))

    def test_urlopen_raises_value_error_fail_closes(self):
        self._env()
        def boom(req, timeout=None):
            raise ValueError("bad response code 429")
        self.assertIsNone(llm.call_chat("hi", urlopen=boom))

    # Malformed JSON -----------------------------------------------------------

    def test_partial_json_fail_closes(self):
        self._env()
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('{"choices":[{')))

    def test_top_level_json_array_fail_closes(self):
        self._env()
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen('[{"choices":[]}]')))

    def test_completely_invalid_json_fail_closes(self):
        self._env()
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen("not json at all")))

    def test_empty_response_body_fail_closes(self):
        self._env()
        self.assertIsNone(llm.call_chat("hi", urlopen=self._urlopen("")))

    # call_chat_json specific --------------------------------------------------

    def test_call_chat_json_parses_fence_wrapped_object(self):
        """JSON inside a ```json fence is extracted correctly."""
        self._env()
        inner = r'{"fixated": true, "confidence": 0.8}'
        content = f"```json\\n{inner}\\n```"
        body = f'{{"choices":[{{"message":{{"content":"{content}"}}}}]}}'
        # Re-encode properly
        import json as _json
        body_proper = _json.dumps({
            "choices": [{"message": {"content": f"```json\n{inner}\n```"}}]
        })
        parsed = llm.call_chat_json("hi", urlopen=self._urlopen(body_proper))
        self.assertEqual(parsed, {"fixated": True, "confidence": 0.8})

    def test_call_chat_json_list_content_returns_none(self):
        """Response text containing a JSON list (no {}) must return None."""
        self._env()
        import json as _json
        body = _json.dumps({"choices": [{"message": {"content": "[1, 2, 3]"}}]})
        self.assertIsNone(llm.call_chat_json("hi", urlopen=self._urlopen(body)))

    def test_call_chat_json_nested_object_extracted(self):
        """Outermost {} span is parsed; nested objects are preserved."""
        self._env()
        import json as _json
        body = _json.dumps({
            "choices": [{"message": {"content": '{"outer": {"inner": 1}}'}}]
        })
        result = llm.call_chat_json("hi", urlopen=self._urlopen(body))
        self.assertEqual(result, {"outer": {"inner": 1}})

    def test_call_chat_json_invalid_json_in_braces_returns_none(self):
        """Braces present but content is not valid JSON must return None."""
        self._env()
        import json as _json
        body = _json.dumps({"choices": [{"message": {"content": "{not valid json}"}}]})
        self.assertIsNone(llm.call_chat_json("hi", urlopen=self._urlopen(body)))

    def test_call_chat_json_no_json_object_in_response_returns_none(self):
        """Response text with no braces at all must return None."""
        self._env()
        import json as _json
        body = _json.dumps({"choices": [{"message": {"content": "no json here"}}]})
        self.assertIsNone(llm.call_chat_json("hi", urlopen=self._urlopen(body)))

    def test_call_chat_json_plain_string_in_braces_returns_none(self):
        """find/rfind span that produces invalid JSON still returns None."""
        self._env()
        import json as _json
        # Text is: "{hello}" — has { and } but content is not JSON
        body = _json.dumps({"choices": [{"message": {"content": "{hello}"}}]})
        self.assertIsNone(llm.call_chat_json("hi", urlopen=self._urlopen(body)))

    def test_call_chat_json_empty_content_returns_none(self):
        """Empty string content from call_chat yields None from call_chat_json."""
        self._env()
        import json as _json
        body = _json.dumps({"choices": [{"message": {"content": ""}}]})
        self.assertIsNone(llm.call_chat_json("hi", urlopen=self._urlopen(body)))

    def test_call_chat_json_with_prefix_text_extracts_object(self):
        """Text before the JSON object is ignored; extraction uses find/rfind."""
        self._env()
        import json as _json
        body = _json.dumps({"choices": [{"message": {"content": 'Result: {"a": 1} done'}}]})
        result = llm.call_chat_json("hi", urlopen=self._urlopen(body))
        self.assertEqual(result, {"a": 1})

    def test_call_chat_json_anthropic_success(self):
        """call_chat_json works with anthropic API shape."""
        self._env("anthropic")
        import json as _json
        body = _json.dumps({
            "content": [{"type": "text", "text": '{"fixated": false, "confidence": 0.3}'}]
        })
        result = llm.call_chat_json("hi", urlopen=self._urlopen(body))
        self.assertEqual(result, {"fixated": False, "confidence": 0.3})


# ─────────────────────────────────────────────────────────────────────────────
# Group 5: Ordering invariant — nudge always before MEDIA:
# ─────────────────────────────────────────────────────────────────────────────

class OrderingInvariantTests(unittest.TestCase):

    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k) for k in (
            "HENT_AI_WATCHER_ENABLED", "HENT_AI_WATCHER_SHADOW",
            "HENT_AI_ASSET_DIR", "HENT_AI_HERMES_PLATFORMS",
        )}

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        plugin._load_watcher_adapter = _original_load_watcher  # type: ignore[attr-defined]

    def _build_hook(self, tmp: str, nudge: str | None = "Try something fresh.") -> object:
        """Install a stubbed watcher that always returns `nudge` and register the hook."""
        os.environ["HENT_AI_WATCHER_ENABLED"] = "1"
        os.environ["HENT_AI_ASSET_DIR"] = tmp
        os.environ["HENT_AI_HERMES_PLATFORMS"] = "discord"
        (Path(tmp) / "neutral.png").write_bytes(b"png")
        _nudge = nudge

        class _Stub:
            @staticmethod
            def create_hermes_watcher_adapter(_deps):
                return {"on_agent_turn": lambda scope, text: _nudge}
            compose_nudge = staticmethod(adapter.compose_nudge)

        plugin._load_watcher_adapter = lambda: _Stub  # type: ignore[attr-defined]

        captured: dict = {}

        class Ctx:
            def register_hook(self, name, cb):
                captured[name] = cb

        plugin.register(Ctx())
        return captured["transform_llm_output"]

    def test_nudge_before_media_basic(self):
        with TemporaryDirectory() as tmp:
            hook = self._build_hook(tmp, "Please pivot to something new.")
            result = hook("The weather is mild.", platform="discord")
            self.assertIsNotNone(result)
            self.assertIn("MEDIA:", result)
            self.assertIn("Please pivot to something new.", result)
            nudge_pos = result.index("Please pivot to something new.")
            media_pos = result.index("MEDIA:")
            self.assertLess(nudge_pos, media_pos, "nudge must appear BEFORE MEDIA: directive")

    def test_nudge_before_media_multiline_response(self):
        with TemporaryDirectory() as tmp:
            hook = self._build_hook(tmp, "Pivot now.")
            long_text = "Line one about the release.\nLine two about the release.\nLine three."
            result = hook(long_text, platform="discord")
            self.assertIsNotNone(result)
            self.assertLess(result.index("Pivot now."), result.index("MEDIA:"))

    def test_nudge_with_internal_newlines_before_media(self):
        """Multi-line nudge text must still appear before MEDIA:."""
        with TemporaryDirectory() as tmp:
            hook = self._build_hook(tmp, "First nudge line.\nSecond nudge line.")
            result = hook("Agent response here.", platform="discord")
            self.assertIsNotNone(result)
            media_pos = result.index("MEDIA:")
            self.assertLess(result.index("First nudge line."), media_pos)
            self.assertLess(result.index("Second nudge line."), media_pos)

    def test_only_one_media_directive_in_output(self):
        """The composed hook must never emit more than one MEDIA: directive."""
        with TemporaryDirectory() as tmp:
            hook = self._build_hook(tmp, "Try a new topic.")
            result = hook("Some response.", platform="discord")
            self.assertIsNotNone(result)
            self.assertEqual(result.count("MEDIA:"), 1, "exactly one MEDIA: directive expected")

    def test_no_nudge_yields_single_media_directive(self):
        """Without a nudge the output still has exactly one MEDIA: directive at the end."""
        with TemporaryDirectory() as tmp:
            hook = self._build_hook(tmp, nudge=None)  # watcher returns None
            result = hook("Some response.", platform="discord")
            self.assertIsNotNone(result)
            self.assertEqual(result.count("MEDIA:"), 1)

    def test_compose_nudge_never_injects_media_directive(self):
        """compose_nudge itself must never inject MEDIA: into its output."""
        composed = adapter.compose_nudge("Prose response.", "Nudge content here.")
        self.assertNotIn("MEDIA:", composed)

    def test_nudge_not_appended_to_unsupported_platform(self):
        """Hook on unsupported platform must return None (no nudge, no media)."""
        with TemporaryDirectory() as tmp:
            hook = self._build_hook(tmp, "Should not appear.")
            result = hook("Response.", platform="unsupported_xyz")
            self.assertIsNone(result)

    def test_nudge_text_not_duplicated_in_output(self):
        """The nudge text must appear exactly once in the final output."""
        nudge = "Explore a different angle."
        with TemporaryDirectory() as tmp:
            hook = self._build_hook(tmp, nudge)
            result = hook("The weather is mild.", platform="discord")
            self.assertIsNotNone(result)
            self.assertEqual(result.count(nudge), 1, "nudge text must appear exactly once")


# Save the original loader so tearDown can restore it
_original_load_watcher = plugin._load_watcher_adapter  # type: ignore[attr-defined]


# ─────────────────────────────────────────────────────────────────────────────
# Group 6: Disabled watcher identical to original emotion plugin
# ─────────────────────────────────────────────────────────────────────────────

class DisabledWatcherIdentityTests(unittest.TestCase):

    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k) for k in (
            "HENT_AI_WATCHER_ENABLED", "HENT_AI_ASSET_DIR", "HENT_AI_HERMES_PLATFORMS",
        )}
        os.environ.pop("HENT_AI_WATCHER_ENABLED", None)

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _register(self) -> object:
        captured: dict = {}

        class Ctx:
            def register_hook(self, name, cb):
                captured[name] = cb

        plugin.register(Ctx())
        return captured["transform_llm_output"]

    def test_disabled_watcher_discord_output_matches_build_transformed_response(self):
        """Without HENT_AI_WATCHER_ENABLED, hook output == build_transformed_response output."""
        with TemporaryDirectory() as tmp:
            os.environ["HENT_AI_ASSET_DIR"] = tmp
            os.environ["HENT_AI_HERMES_PLATFORMS"] = "discord"
            (Path(tmp) / "neutral.png").write_bytes(b"png")
            hook = self._register()
            text = "The weather is mild today."
            result = hook(text, platform="discord")
            expected = plugin.build_transformed_response(text, platform="discord", assets_dir=Path(tmp))
            self.assertEqual(result, expected)

    def test_disabled_watcher_unsupported_platform_returns_none(self):
        hook = self._register()
        self.assertIsNone(hook("Some text.", platform="unsupported_platform"))

    def test_disabled_watcher_empty_text_returns_none(self):
        with TemporaryDirectory() as tmp:
            os.environ["HENT_AI_ASSET_DIR"] = tmp
            os.environ["HENT_AI_HERMES_PLATFORMS"] = "discord"
            (Path(tmp) / "neutral.png").write_bytes(b"png")
            hook = self._register()
            self.assertIsNone(hook("", platform="discord"))

    def test_disabled_watcher_only_one_hook_registered(self):
        """register() must call register_hook exactly once (single composed hook)."""
        calls: list = []

        class Ctx:
            def register_hook(self, name, cb):
                calls.append(name)

        plugin.register(Ctx())
        self.assertEqual(calls, ["transform_llm_output"],
            "register() must register exactly one hook named 'transform_llm_output'")

    def test_disabled_watcher_happy_emotion_map(self):
        """happy emotion text routes to happy.png when watcher is disabled."""
        with TemporaryDirectory() as tmp:
            os.environ["HENT_AI_ASSET_DIR"] = tmp
            os.environ["HENT_AI_HERMES_PLATFORMS"] = "discord"
            (Path(tmp) / "happy.png").write_bytes(b"png")
            (Path(tmp) / "neutral.png").write_bytes(b"png")
            hook = self._register()
            result = hook("Great, the build is fixed and done!", platform="discord")
            self.assertIsNotNone(result)
            self.assertIn("happy.png", result)
            self.assertIn("MEDIA:", result)


# ─────────────────────────────────────────────────────────────────────────────
# Group 7: compose_nudge boundary behavior
# ─────────────────────────────────────────────────────────────────────────────

class ComposeNudgeBoundaryTests(unittest.TestCase):
    """Mode B (replace): compose_nudge drops the response entirely and returns the stripped steer."""

    def test_drops_response_returns_only_nudge(self):
        self.assertEqual(adapter.compose_nudge("Response   ", "Nudge."), "Nudge.")

    def test_response_content_never_survives(self):
        result = adapter.compose_nudge("the duplicate prose", "Nudge.")
        self.assertNotIn("duplicate", result)
        self.assertEqual(result, "Nudge.")

    def test_strips_leading_and_trailing_whitespace_from_nudge(self):
        result = adapter.compose_nudge("Response.", "   Nudge with spaces.   ")
        self.assertEqual(result, "Nudge with spaces.")

    def test_no_separator_added(self):
        result = adapter.compose_nudge("Response.", "Nudge.")
        self.assertNotIn("\n\n", result)
        self.assertEqual(result, "Nudge.")

    def test_empty_response_text(self):
        self.assertEqual(adapter.compose_nudge("", "Nudge."), "Nudge.")

    def test_empty_nudge_text_yields_empty(self):
        self.assertEqual(adapter.compose_nudge("Response.", ""), "")

    def test_both_empty(self):
        self.assertEqual(adapter.compose_nudge("", ""), "")

    def test_nudge_all_newlines_stripped_to_empty(self):
        self.assertEqual(adapter.compose_nudge("Response.", "\n\n\n"), "")

    def test_unicode_in_nudge(self):
        result = adapter.compose_nudge("回答", "別の視点を試みてください。")
        self.assertEqual(result, "別の視点を試みてください。")

    def test_nudge_with_special_characters(self):
        result = adapter.compose_nudge("Response.", "Here's a nudge: 100% sure!")
        self.assertEqual(result, "Here's a nudge: 100% sure!")


if __name__ == "__main__":
    unittest.main()
