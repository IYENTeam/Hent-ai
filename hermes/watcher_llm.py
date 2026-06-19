"""LLM layer for the anti-fixation watcher (Hermes side).

Pure logic — prompts, strict response parsing, deterministic moderation, and a
factory that builds the injected critic/generator/moderator from a single
``call_chat`` function (hermes/llm_client.py supplies the real one). No relative
imports, so it loads cleanly both as a package and standalone. Targets Python
3.9+. Mirrors openclaw/watcher-llm.ts (the LLM layer is non-deterministic and
always mocked in tests, so no cross-language parity is required here).
"""

from __future__ import annotations

import json
import math
from typing import Callable, Dict, List, Optional, Sequence

MAX_NUDGE_CHARS = 240
CRITIC_SYSTEM = (
    "You judge whether an AI agent is fixating: repeating the same topic or "
    "near-identical wording across its recent turns instead of advancing. Reply "
    "ONLY with compact JSON."
)
DISALLOWED_NUDGE_TOKENS = ["http://", "https://", "@everyone", "@here", "MEDIA:"]


def build_critic_prompt(context: Dict[str, object], recent_texts: Sequence[str]) -> str:
    recent = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(list(recent_texts)[-5:]))
    return "\n".join(
        [
            f"Current topic: {context.get('currentTopic', '')}",
            "Recent agent turns:",
            recent,
            "",
            'Is the agent fixating (repeating itself on one topic)? Reply ONLY as '
            '{"fixated": boolean, "confidence": number between 0 and 1}.',
        ]
    )


def parse_critic_response(text: Optional[str]) -> Optional[Dict[str, object]]:
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    fixated = parsed.get("fixated")
    confidence = parsed.get("confidence")
    if not isinstance(fixated, bool):
        return None
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        return None
    if math.isnan(confidence) or math.isinf(confidence):
        return None
    if confidence < 0 or confidence > 1:
        return None
    return {"fixated": fixated, "confidence": float(confidence)}


def build_generation_prompt(
    signal: Dict[str, object],
    context: Dict[str, object],
    persona: Optional[str] = None,
) -> Dict[str, str]:
    base = (
        "You are the agent itself. Write ONE short, in-character line that gently "
        "pivots away from the over-repeated topic to a fresh angle. No "
        "meta-commentary, no apology, no preamble."
    )
    return {
        "system": f"{persona}\n{base}" if persona else base,
        "user": "\n".join(
            [
                f"You have repeated \"{signal.get('staleFrame', '')}\" across recent turns.",
                f"Suggested pivot: {signal.get('suggestedPivot', '')}",
                f"Current topic: {context.get('currentTopic', '')}",
                "Write the single pivot line now.",
            ]
        ),
    }


def moderate_nudge(text: str) -> bool:
    trimmed = text.strip()
    if not trimmed or len(trimmed) > MAX_NUDGE_CHARS:
        return False
    lowered = trimmed.lower()
    return not any(token.lower() in lowered for token in DISALLOWED_NUDGE_TOKENS)


# call_chat(prompt, system=...) -> Optional[str]
ChatFn = Callable[..., Optional[str]]


def create_watcher_llm(call_chat: ChatFn, persona: Optional[str] = None) -> Dict[str, object]:
    def critic(
        signal: Dict[str, object], context: Dict[str, object], recent_texts: Sequence[str]
    ) -> Optional[Dict[str, object]]:
        return parse_critic_response(
            call_chat(build_critic_prompt(context, recent_texts), system=CRITIC_SYSTEM)
        )

    def generate(signal: Dict[str, object], context: Dict[str, object]) -> Optional[str]:
        prompts = build_generation_prompt(signal, context, persona)
        out = call_chat(prompts["user"], system=prompts["system"])
        cleaned = out.strip() if out else ""
        return cleaned if cleaned else None

    return {"critic": critic, "generate": generate, "moderate": moderate_nudge}
