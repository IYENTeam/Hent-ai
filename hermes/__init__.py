"""Hermes Agent plugin for Hent-ai emotion image attachments.

This module intentionally stays independent from the OpenClaw TypeScript plugin.
Hermes loads Python plugins from ``~/.hermes/plugins/<name>/`` and calls
``register(ctx)``. The plugin uses ``transform_llm_output`` so Hermes Gateway can
handle platform-specific media delivery through its existing ``MEDIA:<path>``
response directive.

Features ported from the OpenClaw TypeScript plugin:
- LLM-powered emotion classifier (OpenAI & Anthropic API)
- Manifest system (``assets/manifest.json``) for discoverable asset sets
- Per-channel set overrides (``assets/channel-overrides.json``)
- Channel filtering (allowlist/blocklist via env vars)
- Rate limiting (configurable per hour)
- NO_REPLY skip
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

# ─── Constants ───────────────────────────────────────────────────────────────

DEFAULT_EMOTION_MAP: dict[str, str] = {
    "happy": "happy.png",
    "neutral": "neutral.png",
    "sorry": "sorry.png",
    "confused": "confused.png",
    "focused": "focused.png",
}

DEFAULT_EMOTION = "neutral"

DEFAULT_SUPPORTED_PLATFORMS: set[str] = {
    "discord",
    "telegram",
    "slack",
    "matrix",
    "mattermost",
}

LLM_TIMEOUT_SECONDS = 15

EMOTION_RULES: list[tuple[str, tuple[re.Pattern[str], ...]]] = [
    (
        "sorry",
        (
            re.compile(r"sorry|apolog|my bad|mistake|messed up|regret|oops", re.I),
        ),
    ),
    (
        "happy",
        (
            re.compile(
                r"done|complete|succeed|fixed|shipped|great|awesome|excellent|"
                r"perfect|nailed|pass|resolved|\u2705|\U0001f389|\U0001f525",
                re.I,
            ),
            re.compile(
                r"proud|happy|fantastic|wonderful|congrats|celebrate|woohoo|yay",
                re.I,
            ),
        ),
    ),
    (
        "confused",
        (
            re.compile(
                r"confused|unclear|not sure|strange|unknown cause|weird|unexpected",
                re.I,
            ),
            re.compile(r"question|how do we|what should|any idea", re.I),
        ),
    ),
    (
        "focused",
        (
            re.compile(
                r"investigating|debugging|analyzing|implementing|working on|coding|building",
                re.I,
            ),
            re.compile(
                r"in progress|checking|processing|deploying|testing|verifying",
                re.I,
            ),
        ),
    ),
]


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _split_csv(value: str | None) -> set[str]:
    """Split a comma-separated string into a set of stripped, lowercased items."""
    if not value:
        return set()
    return {item.strip().lower() for item in value.split(",") if item.strip()}


def supported_platforms() -> set[str]:
    """Return platforms that should receive emotion images.

    Set ``HENT_AI_HERMES_PLATFORMS`` to a comma-separated list to override the
    default. Set it to ``*`` to allow every Hermes platform.
    """
    raw = os.getenv("HENT_AI_HERMES_PLATFORMS")
    if raw and raw.strip() == "*":
        return {"*"}
    configured = _split_csv(raw)
    return configured or set(DEFAULT_SUPPORTED_PLATFORMS)


def resolve_assets_dir() -> Path:
    """Resolve the emotion image directory for source and installed layouts.

    Override via ``HENT_AI_ASSET_DIR`` environment variable.
    """
    override = os.getenv("HENT_AI_ASSET_DIR")
    if override:
        return Path(override).expanduser().resolve()

    plugin_dir = Path(__file__).resolve().parent
    local_assets = plugin_dir / "assets"
    if local_assets.exists():
        return local_assets

    # Repository layout: hermes/__init__.py next to ../assets/.
    return plugin_dir.parent / "assets"


# ─── Manifest System ─────────────────────────────────────────────────────────


AssetManifest = dict[str, Any]
AssetSet = dict[str, Any]


def load_manifest(assets_dir: Path) -> AssetManifest | None:
    """Load ``manifest.json`` from the assets directory.

    Returns the parsed manifest dict or ``None`` when the file is missing or
    contains invalid JSON.
    """
    manifest_path = assets_dir / "manifest.json"
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            return json.load(f)  # type: ignore[no-any-return]
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def get_active_set(manifest: AssetManifest) -> tuple[str, AssetSet] | None:
    """Return ``(set_id, set_data)`` for the manifest's active set.

    Returns ``None`` when no active set is configured or the set is missing
    from the manifest.
    """
    active_id: str = manifest.get("activeSet", "")
    if not active_id:
        return None
    sets: dict[str, AssetSet] = manifest.get("sets", {})
    set_data = sets.get(active_id)
    if not set_data:
        return None
    return active_id, set_data


def build_emotion_map_from_set(set_id: str, set_data: AssetSet) -> dict[str, str]:
    """Build an emotion-to-filename mapping from a manifest set.

    Filenames include the set path prefix, e.g. ``sets/gothic-v1/happy.png``,
    matching the OpenClaw convention.
    """
    result: dict[str, str] = {}
    emotions: dict[str, list[str]] = set_data.get("emotions", {})
    for emotion, files in emotions.items():
        if files:
            result[emotion] = f"sets/{set_id}/{files[0]}"
    return result


# ─── Channel Overrides ───────────────────────────────────────────────────────


ChannelOverrides = dict[str, str]


def load_channel_overrides(assets_dir: Path) -> ChannelOverrides:
    """Load per-channel set overrides from ``channel-overrides.json``.

    Returns a ``{channel_id: set_id}`` mapping, or an empty dict when the file
    is missing or contains invalid JSON.
    """
    overrides_path = assets_dir / "channel-overrides.json"
    try:
        with open(overrides_path, "r", encoding="utf-8") as f:
            return json.load(f)  # type: ignore[no-any-return]
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_channel_overrides(
    assets_dir: Path, overrides: ChannelOverrides
) -> None:
    """Save per-channel set overrides to ``channel-overrides.json``.

    Writes the full overrides dict as pretty-printed JSON, matching the
    OpenClaw TypeScript format.
    """
    overrides_path = assets_dir / "channel-overrides.json"
    with open(overrides_path, "w", encoding="utf-8") as f:
        json.dump(overrides, f, indent=2, ensure_ascii=False)
        f.write("\n")


def handle_mode_command(
    text: str,
    channel_id: str,
    assets_dir: Path,
) -> tuple[bool, str | None, str | None]:
    """Detect and handle in-chat mode switching commands.

    Recognised commands (case-insensitive, partial match):
    * ``"private mode on"``, ``"private 모드"``, ``"프라이빗 모드"``
      → Set channel override to ``"private"``.
    * ``"private off"``, ``"일반 모드"``, ``"normal mode"``, ``"기본 모드"``
      → Remove channel override (revert to default).
    * ``"set to <name>"``, ``"에셋 세트 <name>"``, ``"<name> 모드"``
      → Set channel override to any named set.

    Returns ``(changed, message, mode)`` where:
    * ``changed`` — ``True`` when a mode command was detected and executed.
    * ``message`` — Confirmation text (or ``None`` when unchanged).
    * ``mode`` — The mode that was set, or ``"default"`` on reset (or ``None``
      when unchanged).
    """
    lowered = text.strip().lower()
    if not lowered or not channel_id:
        return False, None, None

    overrides = load_channel_overrides(assets_dir)

    is_on = (
        "private mode on" in lowered
        or "private on" in lowered
        or "private 모드" in lowered
        or "프라이빗 모드" in lowered
    )
    is_off = (
        "private off" in lowered
        or "private mode off" in lowered
        or "일반 모드" in lowered
        or "normal mode" in lowered
        or "기본 모드" in lowered
    )

    # "set to <name>" pattern
    set_match: re.Match[str] | None = None
    set_name: str | None = None
    for prefix in ("set to ", "에셋 세트 "):
        if lowered.startswith(prefix):
            rest = lowered[len(prefix):].strip()
            if rest:
                set_match = True
                set_name = rest
                break
    # "<name> 모드" pattern (e.g. "gothic 모드")
    if not set_match:
        mode_match = re.match(r"^([a-z0-9_-]+)\s*모드", lowered)
        if mode_match and mode_match.group(1) not in ("on", "off"):
            set_match = True
            set_name = mode_match.group(1)

    if is_on:
        overrides[channel_id] = "private"
        save_channel_overrides(assets_dir, overrides)
        return True, "Private mode activated for this channel.", "private"

    if is_off:
        overrides.pop(channel_id, None)
        save_channel_overrides(assets_dir, overrides)
        return True, "Reverted to default mode for this channel.", "default"

    if set_match and set_name:
        overrides[channel_id] = set_name
        save_channel_overrides(assets_dir, overrides)
        return True, f"Switched to '{set_name}' set for this channel.", set_name

    return False, None, None


# ─── Rate Limiter ────────────────────────────────────────────────────────────


class RateLimiter:
    """Simple in-memory rate limiter for emotion image attachments.

    Limits the number of allowed operations per rolling one-hour window.
    """

    def __init__(self, limit: int = 60) -> None:
        self._limit = limit
        self._count = 0
        self._window_start = time.monotonic()
        self._window_seconds = 3600

    def can_generate(self) -> bool:
        """Return ``True`` if a new operation is allowed."""
        self._reset_if_needed()
        return self._count < self._limit

    def record_generation(self) -> None:
        """Record that an operation was performed, consuming one unit."""
        self._reset_if_needed()
        self._count += 1

    @property
    def remaining(self) -> int:
        """Return how many more operations are allowed in the current window."""
        self._reset_if_needed()
        return max(0, self._limit - self._count)

    @property
    def limit(self) -> int:
        """Return the configured per-window limit."""
        return self._limit

    def _reset_if_needed(self) -> None:
        """Reset the counter if the time window has expired."""
        if time.monotonic() - self._window_start >= self._window_seconds:
            self._count = 0
            self._window_start = time.monotonic()


# ─── LLM Classifier ──────────────────────────────────────────────────────────


def _get_llm_config() -> dict[str, str] | None:
    """Read LLM configuration from environment variables.

    Returns ``None`` when the classifier is not configured (model or API key
    missing), which triggers a fallback to rule-based detection.

    Environment variables:
        HENT_AI_LLM_MODEL     (required)  e.g. ``"gpt-5.4-mini"``
        HENT_AI_LLM_API_KEY   (required)
        HENT_AI_LLM_BASE_URL  (optional)  defaults to ``"https://api.openai.com/v1"``
    """
    model = os.getenv("HENT_AI_LLM_MODEL")
    api_key = os.getenv("HENT_AI_LLM_API_KEY")
    if not model or not api_key:
        return None
    base_url = os.getenv("HENT_AI_LLM_BASE_URL", "https://api.openai.com/v1")
    return {
        "model": model,
        "api_key": api_key,
        "base_url": base_url.rstrip("/"),
    }


def _is_anthropic_model(model: str) -> bool:
    """Detect whether the model identifier belongs to Anthropic."""
    return "claude" in model.lower()


def _call_llm_api(config: dict[str, str], prompt: str) -> str | None:
    """Call an LLM API (OpenAI-compatible or Anthropic) and return the text.

    The ``temperature`` parameter is intentionally omitted for compatibility
    with reasoning models that reject it.
    """
    model: str = config["model"]
    api_key: str = config["api_key"]
    base_url: str = config["base_url"]

    if _is_anthropic_model(model):
        url = f"{base_url}/messages"
        payload = json.dumps(
            {
                "model": model,
                "max_tokens": 10,
                "messages": [{"role": "user", "content": prompt}],
            }
        ).encode("utf-8")
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "User-Agent": "HentAiHermes/1.0",
        }
    else:
        url = f"{base_url}/chat/completions"
        payload = json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 10,
                # Intentionally no temperature for reasoning-model compatibility
            }
        ).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "HentAiHermes/1.0",
        }

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_SECONDS) as resp:
            raw: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError):
        return None

    if _is_anthropic_model(model):
        blocks: list[dict[str, Any]] = raw.get("content", [])
        if not blocks:
            return None
        text_val: str = (blocks[0].get("text", "") or "").strip()
        return text_val if text_val else None

    choices: list[dict[str, Any]] = raw.get("choices", [])
    if not choices:
        return None
    text: str | None = choices[0].get("message", {}).get("content")
    return text.strip() if text else None


def extract_emotion(content: str | None, valid_emotions: list[str]) -> str | None:
    """Extract a valid emotion from LLM response text with robust parsing.

    Tries, in order:
    1. Exact trimmed match
    2. Line-by-line match
    3. Quote-stripped match
    4. Word-boundary fallback (earliest match in text)
    """
    if not content:
        return None

    trimmed = content.strip().lower()
    if not trimmed:
        return None

    # Exact match
    if trimmed in valid_emotions:
        return trimmed

    # Line-by-line
    for line in trimmed.split("\n"):
        clean = line.strip()
        if clean in valid_emotions:
            return clean

    # Strip surrounding quotes and punctuation marks
    unquoted = trimmed.strip(" \"'`\u2018\u2019\u201c\u201d")
    if unquoted in valid_emotions:
        return unquoted

    for line in unquoted.split("\n"):
        clean = line.strip()
        if clean in valid_emotions:
            return clean

    # Word-boundary fallback: find the earliest match in the original text
    earliest: tuple[str, int] | None = None
    for emotion in valid_emotions:
        match = re.search(rf"\b{re.escape(emotion)}\b", content, re.IGNORECASE)
        if match and (earliest is None or match.start() < earliest[1]):
            earliest = (emotion, match.start())

    return earliest[0] if earliest else None


def classify_emotion_with_llm(
    text: str,
    valid_emotions: list[str],
) -> str | None:
    """Classify emotion via LLM.

    Requires ``HENT_AI_LLM_MODEL`` and ``HENT_AI_LLM_API_KEY`` env vars.
    Optionally ``HENT_AI_LLM_BASE_URL`` (defaults to OpenAI).

    Returns the matching emotion string or ``None`` on failure/fallback.
    """
    config = _get_llm_config()
    if not config:
        return None

    emotions_fmt = ", ".join(f'"{e}"' for e in valid_emotions)
    prompt = (
        f"Classify the emotion of this message into exactly one of: "
        f"{emotions_fmt}. Reply with ONLY the emotion word, nothing else.\n\n"
        f"Message: {text}"
    )

    content = _call_llm_api(config, prompt)
    return extract_emotion(content, valid_emotions)


# ─── Channel Filtering ───────────────────────────────────────────────────────


def _get_channel_filter() -> tuple[str, set[str]]:
    """Read channel filtering config from environment.

    Environment variables:
        HENT_AI_CHANNEL_MODE   ``"allowlist"`` or ``"blocklist"``
        HENT_AI_CHANNEL_LIST   comma-separated channel IDs

    Returns ``(mode, channel_set)``. Mode is ``""`` when no filter is
    configured.
    """
    mode = os.getenv("HENT_AI_CHANNEL_MODE", "").strip().lower()
    raw_list = os.getenv("HENT_AI_CHANNEL_LIST", "")
    channel_set: set[str] = {c.strip() for c in raw_list.split(",") if c.strip()}
    return mode, channel_set


def is_channel_enabled(channel_id: str) -> bool:
    """Check whether emotion images should be attached for the given channel.

    Behavior depends on env vars:
    * No config: all channels enabled (``True``).
    * ``allowlist``: only IDs in the list.
    * ``blocklist``: all IDs except those in the list.
    """
    if not channel_id:
        return False
    mode, channel_set = _get_channel_filter()
    if not channel_set:
        return True
    if mode == "allowlist":
        return channel_id in channel_set
    if mode == "blocklist":
        return channel_id not in channel_set
    return True


# ─── Emotion Detection ───────────────────────────────────────────────────────


def detect_emotion(text: str, fallback: str = DEFAULT_EMOTION) -> str:
    """Detect emotion from assistant response text using regex pattern matching.

    Falls back to ``fallback`` (default: ``"neutral"``) when no rule matches.
    """
    for emotion, patterns in EMOTION_RULES:
        for pattern in patterns:
            if pattern.search(text):
                return emotion
    return fallback


# ─── Response Transformation ─────────────────────────────────────────────────

_global_rate_limiter: RateLimiter | None = None


def _get_global_rate_limiter() -> RateLimiter:
    """Return the module-level rate limiter, initialised from env on first call."""
    global _global_rate_limiter  # noqa: PLW0603
    if _global_rate_limiter is None:
        limit = int(os.getenv("HENT_AI_RATE_LIMIT", "60"))
        _global_rate_limiter = RateLimiter(limit=limit)
    return _global_rate_limiter


def should_attach_for_platform(platform: str, allowed: Iterable[str] | None = None) -> bool:
    """Return whether a Hermes platform should receive image attachments."""
    if not platform:
        return False
    normalized = platform.lower()
    allowed_set = set(allowed) if allowed is not None else supported_platforms()
    return "*" in allowed_set or normalized in allowed_set


def _resolve_emotion_map_for_channel(
    assets_dir: Path,
    manifest: AssetManifest | None,
    channel_id: str | None = None,
) -> dict[str, str]:
    """Build the effective emotion-to-filename map for a channel.

    Priority (highest wins):
    1. Channel override set (if present and valid)
    2. Manifest active set
    3. Built-in ``DEFAULT_EMOTION_MAP``
    """
    result = dict(DEFAULT_EMOTION_MAP)

    if manifest:
        active = get_active_set(manifest)
        if active:
            set_id, set_data = active
            result.update(build_emotion_map_from_set(set_id, set_data))

    if channel_id:
        overrides = load_channel_overrides(assets_dir)
        override_set_id = overrides.get(channel_id)
        if override_set_id and manifest:
            sets: dict[str, AssetSet] = manifest.get("sets", {})
            override_set = sets.get(override_set_id)
            if override_set:
                result.update(
                    build_emotion_map_from_set(override_set_id, override_set)
                )

    return result


def build_transformed_response(
    response_text: str,
    *,
    platform: str,
    assets_dir: Path | None = None,
    emotion_map: dict[str, str] | None = None,
    channel_id: str | None = None,
) -> str | None:
    """Build a Hermes response with a ``MEDIA:`` directive, or ``None`` to skip.

    Returns ``None`` (no modification) when:
    * The response is empty or exactly ``NO_REPLY``
    * The platform is not in the allowed list
    * No matching image file exists on disk
    * The rate limit has been exceeded
    """
    # ── Guards ──────────────────────────────────────────────────────────

    if not response_text or response_text.strip() == "NO_REPLY":
        return None

    if not should_attach_for_platform(platform):
        return None

    resolved_assets_dir = assets_dir or resolve_assets_dir()

    # ── Manifest & emotion map ──────────────────────────────────────────

    manifest = load_manifest(resolved_assets_dir)

    if emotion_map is not None:
        effective_map: dict[str, str] = emotion_map
    else:
        effective_map = _resolve_emotion_map_for_channel(
            resolved_assets_dir, manifest, channel_id
        )

    # ── Emotion classification ──────────────────────────────────────────

    valid_emotions = list(effective_map.keys())
    emotion = classify_emotion_with_llm(response_text, valid_emotions)
    if not emotion:
        emotion = detect_emotion(response_text)

    # ── Image resolution ────────────────────────────────────────────────

    filename = effective_map.get(emotion) or effective_map.get(DEFAULT_EMOTION)
    if not filename:
        return None

    image_path = (resolved_assets_dir / filename).resolve()
    if not image_path.exists():
        return None

    # ── Rate limiting ───────────────────────────────────────────────────

    rate_limiter = _get_global_rate_limiter()
    if not rate_limiter.can_generate():
        return None

    rate_limiter.record_generation()

    # ── Build transformed response ──────────────────────────────────────

    return f"{response_text.rstrip()}\n\nMEDIA:{image_path}"


# ─── Hermes Plugin Entrypoint ────────────────────────────────────────────────


def register(ctx) -> None:
    """Register the Hermes transform hook.

    Called by Hermes Agent when the plugin is loaded. The hook intercepts
    ``transform_llm_output`` to append a ``MEDIA:`` directive for the
    classified emotion image.
    """

    def attach_emotion_image(
        response_text: str,
        platform: str = "",
        channel_id: str | None = None,
        **_kwargs: Any,
    ) -> str | None:
        if not is_channel_enabled(channel_id or ""):
            return None
        return build_transformed_response(
            response_text,
            platform=platform,
            channel_id=channel_id,
        )

    ctx.register_hook("transform_llm_output", attach_emotion_image)
