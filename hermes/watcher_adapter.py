"""Hermes-side thin adapter for the anti-fixation watcher.

Mirrors openclaw/watcher-adapter.ts but adapts to the Hermes delivery model:
Hermes delivers by EDITING the authoritative response text (the
``transform_llm_output`` hook returns the replacement string), so instead of a
separate gated ``deliver`` call this adapter returns the nudge text to inline
into the prose (the caller composes nudge-into-prose THEN the trailing MEDIA
directive). All gate/branch logic lives here; the hook stays a single composed
path.

Boundaries match the TS adapter: derived-state-only bounded per-scope transcript
store (idle-evicted, LRU-capped), host-owned scope/ids read not minted, nudge
only past an allowing gate, cooldown/dedup committed only when a nudge is
actually inlined. ``shadow_mode`` defaults ON (audit-only). The LLM
critic/generator/moderator are injected; absent on a live path the adapter
fail-closes (no nudge) instead of a permissive default. Targets Python 3.9+.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Sequence

try:  # works as a package (import hermes.watcher_adapter)
    from . import watcher_core as core
except ImportError:  # works when loaded standalone via spec_from_file_location
    import importlib.util as _ilu
    from pathlib import Path as _Path

    _core_spec = _ilu.spec_from_file_location(
        "hent_ai_watcher_core", _Path(__file__).resolve().parent / "watcher_core.py"
    )
    assert _core_spec is not None and _core_spec.loader is not None
    core = _ilu.module_from_spec(_core_spec)
    _core_spec.loader.exec_module(core)

WATCHER_WINDOW_N = 8
WATCHER_SCOPE_TTL_MS = 1_800_000  # 30 min idle eviction
WATCHER_MAX_SCOPES = 500
DEFAULT_COOLDOWN_MS = 600_000
DEFAULT_BUDGET_PER_HOUR = 20
DEFAULT_CONFIDENCE_THRESHOLD = 0.7
HOUR_MS = 3_600_000

# Injected dependency types (all optional except logger):
#   critic(signal, context, recent_texts) -> Optional[dict{"fixated":bool,"confidence":float}]
#   generate(signal, context) -> Optional[str]
#   moderate(text) -> bool
Critic = Callable[[Dict[str, object], Dict[str, object], Sequence[str]], Optional[Dict[str, object]]]
Generator = Callable[[Dict[str, object], Dict[str, object]], Optional[str]]
Moderator = Callable[[str], bool]


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)


def create_hermes_watcher_adapter(deps: Dict[str, object]):
    cfg: Dict[str, object] = deps.get("config") or {}
    logger = deps["logger"]
    shadow_mode = bool(cfg.get("shadowMode", True))
    cooldown_ms = int(cfg.get("cooldownMs", DEFAULT_COOLDOWN_MS))
    budget_per_hour = int(cfg.get("budgetPerHour", DEFAULT_BUDGET_PER_HOUR))
    confidence_threshold = float(cfg.get("confidenceThreshold", DEFAULT_CONFIDENCE_THRESHOLD))
    enabled = bool(cfg.get("enabled", False))
    critic: Optional[Critic] = deps.get("critic")  # type: ignore[assignment]
    generate: Optional[Generator] = deps.get("generate")  # type: ignore[assignment]
    moderate: Optional[Moderator] = deps.get("moderate")  # type: ignore[assignment]
    now: Callable[[], int] = deps.get("now") or _now_ms  # type: ignore[assignment]
    iso_now: Callable[[], str] = deps.get("isoNow") or (lambda: core.DEFAULT_NOW)  # type: ignore[assignment]

    buffers: "Dict[str, Dict[str, object]]" = {}
    budgets: "Dict[str, Dict[str, int]]" = {}
    last_delivered: Dict[str, int] = {}
    delivered_signals = set()
    state = {"seq": 0}

    def evict_idle(current: int) -> None:
        for scope_id in [s for s, b in buffers.items() if current - int(b["lastTouched"]) > WATCHER_SCOPE_TTL_MS]:
            del buffers[scope_id]

    def push(scope_id: str, message: Dict[str, object]) -> List[Dict[str, object]]:
        current = now()
        evict_idle(current)
        buffer = buffers.pop(scope_id, None)
        if buffer is None:
            buffer = {"messages": [], "lastTouched": current}
        msgs: List[Dict[str, object]] = buffer["messages"]  # type: ignore[assignment]
        msgs.append(message)
        if len(msgs) > WATCHER_WINDOW_N:
            buffer["messages"] = msgs[-WATCHER_WINDOW_N:]
        buffer["lastTouched"] = current
        buffers[scope_id] = buffer  # re-insert at tail (LRU order)
        while len(buffers) > WATCHER_MAX_SCOPES:
            del buffers[next(iter(buffers))]
        return buffer["messages"]  # type: ignore[return-value]

    def within_budget(scope_id: str, current: int) -> bool:
        budget = budgets.get(scope_id)
        if budget is None or current - budget["windowStart"] >= HOUR_MS:
            budget = {"windowStart": current, "count": 0}
            budgets[scope_id] = budget
        if budget["count"] >= budget_per_hour:
            return False
        budget["count"] += 1
        return True

    def record_agent_turn(scope_id: str, text: str) -> List[Dict[str, object]]:
        state["seq"] += 1
        return push(scope_id, {"id": f"h-{state['seq']}", "senderRole": "agent", "ts": iso_now(), "text": text})

    def run_live(signal, messages, scope_id, cooldown_key, current) -> Optional[str]:
        if not critic or not generate or not moderate:
            logger.warn("watcher: live mode but LLM critic/generator/moderator missing, fail-closed")
            return None
        if not within_budget(scope_id, current):
            logger.warn(f"watcher: critic budget exceeded for scope={scope_id}, fail-closed (no nudge)")
            return None
        try:
            context = core.create_neutral_conversation_context(scope_id, messages)
            verdict = critic(signal, context, [str(m.get("text", "")) for m in messages])
            if not verdict:
                logger.warn("watcher: critic returned null, fail-closed (no nudge)")
                return None
            if not verdict.get("fixated") or float(verdict.get("confidence", 0)) < confidence_threshold:
                return None
            text = generate(signal, context)
            if not text or not moderate(text):
                logger.warn("watcher: nudge suppressed (empty generation or moderation failed)")
                return None
        except Exception:  # a misbehaving LLM dep must never crash delivery
            logger.warn("watcher: LLM pipeline raised, fail-closed (no nudge)")
            return None
        last_delivered[cooldown_key] = current
        delivered_signals.add(f"{scope_id}:{signal['signalId']}")
        return text

    def on_agent_turn(scope_id: str, text: str) -> Optional[str]:
        """Record the agent turn; return nudge text to inline, or None."""
        messages = record_agent_turn(scope_id, text)
        if not enabled:
            return None
        signals = core.evaluate_fixation(messages, scope_id)
        if not signals:
            return None
        signal = signals[0]
        cooldown_key = f"{scope_id}:{signal['fixationPattern']}"
        current = now()
        cooldown_hit = current - last_delivered.get(cooldown_key, -(2 ** 63)) < cooldown_ms
        duplicate_hit = f"{scope_id}:{signal['signalId']}" in delivered_signals

        nudge_text: Optional[str] = None
        if not shadow_mode and not cooldown_hit and not duplicate_hit:
            nudge_text = run_live(signal, messages, scope_id, cooldown_key, current)

        audit = core.evaluate_host_policy_gate(
            {
                "runtime": "hermes",
                "signal": signal,
                "criticConfidence": 0,
                "shadowMode": shadow_mode,
                "cooldownHit": cooldown_hit,
                "duplicateHit": duplicate_hit,
                "deliveryMessageId": f"inline-{scope_id}" if nudge_text else None,
                "now": iso_now(),
            }
        )
        logger.info(
            f"watcher: scope={scope_id} pattern={signal['fixationPattern']} allowed={audit['allowed']}"
            f" nudged={'yes' if nudge_text else 'no'}"
            + (f" suppressed={audit['suppressedReason']}" if audit.get("suppressedReason") else "")
        )
        return nudge_text

    return {
        "on_agent_turn": on_agent_turn,
        "scope_count": lambda: len(buffers),
    }


def compose_nudge(response_text: str, nudge_text: str) -> str:
    """Replace the would-be repeat with the agent-authored nudge (identity: agent_explicit).

    Mode B (replace): when a stale self-repetition fires, the duplicate response
    prose is dropped entirely and ONLY the steer is emitted (the emotion MEDIA
    directive is still appended downstream by build_transformed_response). The
    ``response_text`` argument is retained for call-site symmetry.
    """
    return nudge_text.strip()
