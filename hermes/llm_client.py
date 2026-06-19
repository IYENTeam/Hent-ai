"""Minimal OpenAI/Anthropic chat client for the Hermes anti-fixation watcher.

Hermes' existing plugin is pure-regex with no LLM client, so the watcher needs
its own. This is intentionally tiny and stdlib-only (no new dependency): it
returns the model text (or a parsed JSON object) and fail-closes to ``None`` on
ANY failure (missing config, network/HTTP error, bad JSON). ``urlopen`` is
injectable so tests never touch the network. Targets Python 3.9+.

Configuration via env:
- ``HENT_AI_LLM_API``      : ``openai`` (default) or ``anthropic``
- ``HENT_AI_LLM_BASE_URL`` : override the provider base URL
- ``HENT_AI_LLM_API_KEY``  : API key (required; without it calls fail-closed)
- ``HENT_AI_LLM_MODEL``    : model id (required)
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Callable, Dict, Optional

DEFAULT_TIMEOUT_S = 15


def _extract_text(api: str, data: Dict[str, Any]) -> Optional[str]:
    try:
        if api == "anthropic":
            for block in data.get("content") or []:
                if block.get("type") == "text" and block.get("text"):
                    return str(block["text"])
            return None
        choices = data.get("choices") or []
        if not choices:
            return None
        content = choices[0].get("message", {}).get("content")
        return str(content) if content else None
    except Exception:
        return None


def call_chat(
    prompt: str,
    *,
    system: Optional[str] = None,
    max_tokens: int = 64,
    timeout_s: int = DEFAULT_TIMEOUT_S,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
) -> Optional[str]:
    """Call the configured chat LLM; return the text content, or None on any failure."""
    api = (os.getenv("HENT_AI_LLM_API", "openai") or "openai").lower()
    base = os.getenv("HENT_AI_LLM_BASE_URL") or (
        "https://api.anthropic.com/v1" if api == "anthropic" else "https://api.openai.com/v1"
    )
    key = os.getenv("HENT_AI_LLM_API_KEY")
    model = os.getenv("HENT_AI_LLM_MODEL")
    if not key or not model:
        return None
    try:
        if api == "anthropic":
            url = f"{base}/messages"
            payload: Dict[str, Any] = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": prompt}],
            }
            if system:
                payload["system"] = system
            headers = {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
        else:
            url = f"{base}/chat/completions"
            messages = ([{"role": "system", "content": system}] if system else []) + [
                {"role": "user", "content": prompt}
            ]
            payload = {"model": model, "max_tokens": max_tokens, "messages": messages}
            headers = {"authorization": f"Bearer {key}", "content-type": "application/json"}
        request = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
        )
        with urlopen(request, timeout=timeout_s) as response:
            data = json.loads(response.read().decode("utf-8"))
        return _extract_text(api, data)
    except Exception:
        return None


def call_chat_json(
    prompt: str,
    *,
    system: Optional[str] = None,
    max_tokens: int = 64,
    timeout_s: int = DEFAULT_TIMEOUT_S,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
) -> Optional[Dict[str, Any]]:
    """Like call_chat but parse the first JSON object in the response; None on failure."""
    text = call_chat(prompt, system=system, max_tokens=max_tokens, timeout_s=timeout_s, urlopen=urlopen)
    if text is None:
        return None
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end < start:
            return None
        parsed = json.loads(text[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None
