"""Pure, deterministic Python port of openclaw/watcher-core.ts.

conversation-watcher (IYENTeam) is a DESIGN REFERENCE only; this is a native
reimplementation that stays in lockstep with the TypeScript core via the shared
golden fixtures (tests/fixtures/watcher-golden.json). The pinned tokenizer,
stop-word set, similarity math, and epsilon below are the parity contract:
changing them requires updating openclaw/watcher-core.ts and the fixtures
together.

No I/O, no LLM, no side effects. Targets Python 3.9+.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Sequence

DEFAULT_NOW = "2026-06-16T00:00:00.000Z"

PRIORITY_STACK = (
    "latest_explicit_instruction",
    "active_nudge",
    "current_topic",
    "older_summary",
)

# Parity contract: identical to STOP_WORDS in openclaw/watcher-core.ts.
STOP_WORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "but", "if", "then", "so", "to", "of", "in",
        "on", "for", "is", "are", "was", "were", "be", "been", "it", "this", "that",
        "i", "you", "we", "they", "as", "at", "by", "with", "about",
        "은", "는", "이", "가", "을", "를", "에", "의", "도", "로", "으로", "고", "과", "와",
    }
)

SIMILARITY_EPSILON = 1e-9

DEFAULT_WINDOW_N = 8
DEFAULT_PERSISTENCE_K = 3
DEFAULT_SIM_THRESHOLD = 0.6
DEFAULT_PERSISTENCE_SIM_FLOOR = 0.4

_INSTRUCTION_KEYWORDS = [
    "don't", "do not", "stop", "instead", "rather",
    "아니", "하지마", "하지 마", "말고", "대신", "그만",
]

# Unicode letter/number runs, mirroring the JS /[\p{L}\p{N}]+/gu tokenizer.
# In Python 3, \w is unicode-aware for str; [^\W_] = word char excluding "_",
# i.e. letters + digits across scripts (matching \p{L}\p{N}).
_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)


def compact(text: str, max_len: int = 220) -> str:
    one_line = re.sub(r"\s+", " ", text).strip()
    if len(one_line) <= max_len:
        return one_line
    return one_line[: max_len - 1] + "…"


def has_any(text: str, needles: Sequence[str]) -> bool:
    lowered = text.lower()
    return any(needle.lower() in lowered for needle in needles)


def tokenize(text: str) -> List[str]:
    return [token for token in _TOKEN_RE.findall(text.lower()) if token not in STOP_WORDS]


def infer_topic(text: str) -> str:
    tokens = tokenize(text)
    if not tokens:
        return "conversation"
    return " ".join(tokens[:4])


def latest_instruction(text: str) -> Optional[str]:
    if has_any(text, _INSTRUCTION_KEYWORDS):
        return compact(text, 160)
    return None


def check(verdict: str, reason: str) -> Dict[str, str]:
    return {"verdict": verdict, "reason": reason}


def approx_gte(value: float, threshold: float, epsilon: float = SIMILARITY_EPSILON) -> bool:
    return value >= threshold - epsilon


def jaccard(a: Sequence[str], b: Sequence[str]) -> float:
    set_a = set(a)
    set_b = set(b)
    intersection = len(set_a & set_b)
    union = len(set_a) + len(set_b) - intersection
    return 0.0 if union == 0 else intersection / union


def bigrams(tokens: Sequence[str]) -> List[str]:
    return [f"{tokens[i - 1]} {tokens[i]}" for i in range(1, len(tokens))]


def similarity(a_text: str, b_text: str) -> float:
    a_tokens = tokenize(a_text)
    b_tokens = tokenize(b_text)
    token_sim = jaccard(a_tokens, b_tokens)
    gram_sim = jaccard(bigrams(a_tokens), bigrams(b_tokens))
    return max(token_sim, gram_sim)


def max_pairwise_similarity(texts: Sequence[str]) -> float:
    max_sim = 0.0
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            sim = similarity(texts[i], texts[j])
            if sim > max_sim:
                max_sim = sim
    return max_sim


def trailing_topic_run(topics: Sequence[str]) -> int:
    if not topics:
        return 0
    run = 1
    for i in range(len(topics) - 1, 0, -1):
        if topics[i] == topics[i - 1]:
            run += 1
        else:
            break
    return run


def _options(options: Optional[Dict[str, object]]) -> Dict[str, object]:
    return options or {}


def detect_stale_repetition(
    messages: Sequence[Dict[str, object]],
    scope_id: str,
    options: Optional[Dict[str, object]] = None,
) -> List[Dict[str, object]]:
    opts = _options(options)
    window_n = int(opts.get("windowN", DEFAULT_WINDOW_N))
    persistence_k = int(opts.get("persistenceK", DEFAULT_PERSISTENCE_K))
    sim_threshold = float(opts.get("simThreshold", DEFAULT_SIM_THRESHOLD))
    floor = float(opts.get("persistenceSimFloor", DEFAULT_PERSISTENCE_SIM_FLOOR))
    now = str(opts.get("now", DEFAULT_NOW))

    window = [m for m in messages if m.get("senderRole") == "agent"][-window_n:]
    if len(window) < 2:
        return []

    max_sim = max_pairwise_similarity([str(m.get("text", "")) for m in window])
    persistence = trailing_topic_run([infer_topic(str(m.get("text", ""))) for m in window])
    repetition = approx_gte(max_sim, sim_threshold)
    stuck = persistence >= persistence_k and approx_gte(max_sim, floor)
    if not repetition and not stuck:
        return []

    last = window[-1]
    stale_frame = infer_topic(str(last.get("text", "")))
    return [
        {
            "schema": "conversation_watcher.internal_anti_fixation_signal.v1",
            "signalId": f"sig-stale-{last.get('id')}",
            "scopeId": scope_id,
            "reason": (
                "Agent is restating near-duplicate content across recent turns."
                if repetition
                else "Agent has stayed on the same frame across consecutive turns."
            ),
            "staleFrame": stale_frame,
            "newContextEvidence": (
                "near-duplicate restatement across recent agent turns"
                if repetition
                else f"same frame across {persistence} consecutive agent turns"
            ),
            "suggestedPivot": f'Move past "{stale_frame}" and offer a genuinely fresh angle.',
            "sourceMessageIds": [m.get("id") for m in window],
            "confidence": 0.6,
            "severity": "high" if repetition else "medium",
            "fixationPattern": "stale_expression_repeated",
            "createdAt": now,
        }
    ]


def detect_correction_driven_fixation(
    messages: Sequence[Dict[str, object]],
    scope_id: str,
    options: Optional[Dict[str, object]] = None,
) -> List[Dict[str, object]]:
    opts = _options(options)
    now = str(opts.get("now", DEFAULT_NOW))
    signals: List[Dict[str, object]] = []
    for i in range(2, len(messages)):
        prev_agent = messages[i - 2]
        correction = messages[i - 1]
        current_agent = messages[i]
        if (
            prev_agent.get("senderRole") != "agent"
            or correction.get("senderRole") != "user"
            or current_agent.get("senderRole") != "agent"
        ):
            continue
        corrected = latest_instruction(str(correction.get("text", ""))) is not None
        repeated_frame = infer_topic(str(prev_agent.get("text", ""))) == infer_topic(
            str(current_agent.get("text", ""))
        )
        new_topic = infer_topic(str(correction.get("text", "")))
        if corrected and repeated_frame and infer_topic(str(current_agent.get("text", ""))) != new_topic:
            signals.append(
                {
                    "schema": "conversation_watcher.internal_anti_fixation_signal.v1",
                    "signalId": f"sig-correction-{current_agent.get('id')}",
                    "scopeId": scope_id,
                    "reason": "Agent repeated the previous frame after a newer explicit instruction.",
                    "staleFrame": infer_topic(str(prev_agent.get("text", ""))),
                    "newContextEvidence": f"{correction.get('id')}: {compact(str(correction.get('text', '')), 120)}",
                    "suggestedPivot": f"Answer from the newer frame: {new_topic}.",
                    "sourceMessageIds": [prev_agent.get("id"), correction.get("id"), current_agent.get("id")],
                    "confidence": 0.9,
                    "severity": "high",
                    "fixationPattern": "new_context_ignored_previous_frame_repeated",
                    "createdAt": now,
                }
            )
    return signals


def evaluate_fixation(
    messages: Sequence[Dict[str, object]],
    scope_id: str,
    options: Optional[Dict[str, object]] = None,
) -> List[Dict[str, object]]:
    return detect_stale_repetition(messages, scope_id, options) + detect_correction_driven_fixation(
        messages, scope_id, options
    )


def create_neutral_conversation_context(
    scope_id: str,
    messages: Sequence[Dict[str, object]],
    now: str = DEFAULT_NOW,
) -> Dict[str, object]:
    users = [m for m in messages if m.get("senderRole") == "user"]
    last_user = users[-1] if users else None
    instruction: Optional[str] = None
    for message in reversed(users):
        candidate = latest_instruction(str(message.get("text", "")))
        if candidate:
            instruction = candidate
            break
    discontinuities: List[Dict[str, str]] = []
    for i in range(1, len(users)):
        prev = users[i - 1]
        cur = users[i]
        prev_topic = infer_topic(str(prev.get("text", "")))
        cur_topic = infer_topic(str(cur.get("text", "")))
        if prev_topic != cur_topic:
            discontinuities.append(
                {
                    "fromMessageId": str(prev.get("id")),
                    "toMessageId": str(cur.get("id")),
                    "kind": "intent" if latest_instruction(str(cur.get("text", ""))) else "topic",
                    "summary": f'Context moved from "{prev_topic}" to "{cur_topic}".',
                }
            )
    return {
        "schema": "conversation_watcher.neutral_context.v1",
        "scopeId": scope_id,
        "sourceMessageIds": [m.get("id") for m in messages],
        "currentTopic": infer_topic(str(last_user.get("text", ""))) if last_user else "conversation",
        "latestExplicitInstruction": instruction,
        "recentUserIntent": compact(str(last_user.get("text", "")), 120) if last_user else None,
        "openQuestions": [
            compact(str(m.get("text", "")), 120)
            for m in users
            if re.search(r"[?？까]\s*$", str(m.get("text", "")).strip())
        ],
        "contextDiscontinuities": discontinuities,
        "summary": compact(
            " | ".join(f"{m.get('senderRole')}: {m.get('text')}" for m in messages), 280
        ),
        "confidence": 0.82 if messages else 0.1,
        "createdAt": now,
    }


def plan_external_nudge(
    runtime: str,
    signal: Dict[str, object],
    text: str,
    target: Optional[Dict[str, str]] = None,
    now: str = DEFAULT_NOW,
) -> Dict[str, object]:
    resolved_target: Dict[str, object] = {"runtime": runtime}
    if target:
        resolved_target.update(target)
    return {
        "schema": "conversation_watcher.external_nudge.v1",
        "nudgeId": f"nudge-{signal.get('signalId')}",
        "scopeId": signal.get("scopeId"),
        "target": resolved_target,
        "text": text,
        "whyNow": signal.get("reason"),
        "suggestedPivot": signal.get("suggestedPivot"),
        "sourceMessageIds": signal.get("sourceMessageIds"),
        "internalSignalId": signal.get("signalId"),
        "identityDisclosure": "agent_explicit",
        "createdAt": now,
    }


def evaluate_host_policy_gate(gate_input: Dict[str, object]) -> Dict[str, object]:
    signal = gate_input["signal"]
    source_thread = gate_input.get("sourceThreadId")
    target_thread = gate_input.get("targetThreadId")
    cross_thread = bool(gate_input.get("crossThreadRisk"))
    thread_matches = not source_thread or not target_thread or source_thread == target_thread
    thread_ok = thread_matches and not cross_thread
    if cross_thread:
        thread_reason = "signal sources span multiple threads"
    elif thread_matches:
        thread_reason = "thread matches or is unspecified"
    else:
        thread_reason = "source and target thread mismatch"

    if gate_input.get("shadowMode"):
        suppressed_reason: Optional[str] = "shadow_mode"
    elif gate_input.get("cooldownHit"):
        suppressed_reason = "cooldown"
    elif gate_input.get("duplicateHit"):
        suppressed_reason = "duplicate"
    elif gate_input.get("privacyRisk"):
        suppressed_reason = "privacy"
    elif not thread_ok:
        suppressed_reason = "thread_mismatch"
    else:
        suppressed_reason = None
    allowed = suppressed_reason is None

    return {
        "schema": "conversation_watcher.host_policy_gate_audit.v1",
        "runtime": gate_input["runtime"],
        "allowed": allowed,
        "reason": "host policy gate allowed native delivery"
        if allowed
        else f"suppressed: {suppressed_reason}",
        "threadId": target_thread,
        "sessionId": gate_input.get("sessionId"),
        "sourceMessageIds": signal.get("sourceMessageIds"),
        "cooldownKey": f"{signal.get('scopeId')}:{signal.get('fixationPattern')}",
        "duplicateCheck": check(
            "blocked" if gate_input.get("duplicateHit") else "passed",
            "duplicate nudge" if gate_input.get("duplicateHit") else "no duplicate",
        ),
        "privacyCheck": check(
            "blocked" if gate_input.get("privacyRisk") else "passed",
            "privacy risk" if gate_input.get("privacyRisk") else "no privacy risk",
        ),
        "threadCheck": check("passed" if thread_ok else "blocked", thread_reason),
        "criticConfidence": gate_input.get("criticConfidence"),
        "fixationPattern": signal.get("fixationPattern"),
        "internalSignalId": signal.get("signalId"),
        "deliveryMessageId": gate_input.get("deliveryMessageId") if allowed else None,
        "suppressedReason": suppressed_reason,
        "createdAt": gate_input.get("now", DEFAULT_NOW),
    }


def evaluate_fixture_result(
    fixture: Dict[str, object],
    options: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    signals = evaluate_fixation(
        fixture.get("rawMessages", []), str(fixture.get("scopeId", "")), options
    )
    return {
        "fixated": len(signals) > 0,
        "patterns": [s.get("fixationPattern") for s in signals],
    }
