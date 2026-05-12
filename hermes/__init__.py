"""Hermes Agent plugin for Hent-ai emotion image attachments.

This module intentionally stays independent from the OpenClaw TypeScript plugin.
Hermes loads Python plugins from ``~/.hermes/plugins/<name>/`` and calls
``register(ctx)``. The plugin uses ``transform_llm_output`` so Hermes Gateway can
handle platform-specific media delivery through its existing ``MEDIA:<path>``
response directive.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterable

DEFAULT_EMOTION_MAP: dict[str, str] = {
    "happy": "happy.png",
    "neutral": "neutral.png",
    "loyalty": "loyalty.png",
    "sorry": "sorry.png",
    "confused": "confused.png",
    "focused": "focused.png",
}

DEFAULT_EMOTION = "neutral"
DEFAULT_SUPPORTED_PLATFORMS = {
    "discord",
    "telegram",
    "slack",
    "matrix",
    "mattermost",
}

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
                r"done|complete|succeed|fixed|shipped|great|awesome|excellent|perfect|nailed|pass|resolved|✅|🎉|🔥",
                re.I,
            ),
            re.compile(r"proud|happy|fantastic|wonderful|congrats|celebrate|woohoo|yay", re.I),
        ),
    ),
    (
        "confused",
        (
            re.compile(r"confused|unclear|not sure|strange|unknown cause|weird|unexpected", re.I),
            re.compile(r"question|how do we|what should|any idea", re.I),
        ),
    ),
    (
        "focused",
        (
            re.compile(r"investigating|debugging|analyzing|implementing|working on|coding|building", re.I),
            re.compile(r"in progress|checking|processing|deploying|testing|verifying", re.I),
        ),
    ),
    (
        "loyalty",
        (
            re.compile(r"got it|understood|on it|yes sir|will do|right away|hello|hi there", re.I),
        ),
    ),
]


def _split_csv(value: str | None) -> set[str]:
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
    """Resolve the emotion image directory for source and installed layouts."""

    override = os.getenv("HENT_AI_ASSET_DIR")
    if override:
        return Path(override).expanduser().resolve()

    plugin_dir = Path(__file__).resolve().parent
    local_assets = plugin_dir / "assets"
    if local_assets.exists():
        return local_assets

    # Repository layout: hermes/__init__.py next to ../assets/.
    return plugin_dir.parent / "assets"


def detect_emotion(text: str, fallback: str = DEFAULT_EMOTION) -> str:
    """Detect an emotion from assistant response text using Hent-ai rules."""

    for emotion, patterns in EMOTION_RULES:
        for pattern in patterns:
            if pattern.search(text):
                return emotion
    return fallback


def should_attach_for_platform(platform: str, allowed: Iterable[str] | None = None) -> bool:
    """Return whether a Hermes platform should receive image attachments."""

    if not platform:
        return False
    normalized = platform.lower()
    allowed_set = set(allowed) if allowed is not None else supported_platforms()
    return "*" in allowed_set or normalized in allowed_set


def build_transformed_response(
    response_text: str,
    *,
    platform: str,
    assets_dir: Path | None = None,
    emotion_map: dict[str, str] | None = None,
) -> str | None:
    """Build a Hermes response with a MEDIA directive, or ``None`` to skip.

    Hermes treats a non-empty string returned from ``transform_llm_output`` as a
    replacement response. Returning ``None`` leaves the original response
    unchanged.
    """

    if not response_text or not should_attach_for_platform(platform):
        return None

    active_map = emotion_map or DEFAULT_EMOTION_MAP
    emotion = detect_emotion(response_text)
    filename = active_map.get(emotion) or active_map.get(DEFAULT_EMOTION)
    if not filename:
        return None

    image_path = (assets_dir or resolve_assets_dir()) / filename
    if not image_path.exists():
        return None

    return f"{response_text.rstrip()}\n\nMEDIA:{image_path.resolve()}"


def register(ctx) -> None:
    """Register the Hermes transform hook."""

    def attach_emotion_image(response_text: str, platform: str = "", **_kwargs) -> str | None:
        return build_transformed_response(response_text, platform=platform)

    ctx.register_hook("transform_llm_output", attach_emotion_image)
