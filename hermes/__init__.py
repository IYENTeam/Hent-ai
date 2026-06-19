"""Hermes Agent plugin for Hent-ai emotion image attachments.

This module intentionally stays independent from the OpenClaw TypeScript plugin.
Hermes loads Python plugins from ``~/.hermes/plugins/<name>/`` and calls
``register(ctx)``. The plugin uses ``transform_llm_output`` so Hermes Gateway can
handle platform-specific media delivery through its existing ``MEDIA:<path>``
response directive.
"""

from __future__ import annotations

import datetime
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
        (re.compile(r"sorry|apolog|my bad|mistake|messed up|regret|oops", re.I),),
    ),
    (
        "happy",
        (
            re.compile(
                r"done|complete|succeed|fixed|shipped|great|awesome|excellent|perfect|nailed|pass|resolved|✅|🎉|🔥",
                re.I,
            ),
            re.compile(
                r"proud|happy|fantastic|wonderful|congrats|celebrate|woohoo|yay", re.I
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
                r"in progress|checking|processing|deploying|testing|verifying", re.I
            ),
        ),
    ),
    (
        "loyalty",
        (
            re.compile(
                r"got it|understood|on it|yes sir|will do|right away|hello|hi there",
                re.I,
            ),
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
        base = Path(override).expanduser().resolve()
    else:
        plugin_dir = Path(__file__).resolve().parent
        local_assets = plugin_dir / "assets"
        base = local_assets if local_assets.exists() else plugin_dir.parent / "assets"

    profile_id = os.getenv("HENT_AI_DEFAULT_PROFILE")
    if profile_id:
        profile_dir = base / "profiles" / profile_id
        if profile_dir.exists():
            return profile_dir

    return base


def detect_emotion(text: str, fallback: str = DEFAULT_EMOTION) -> str:
    """Detect an emotion from assistant response text using Hent-ai rules."""

    for emotion, patterns in EMOTION_RULES:
        for pattern in patterns:
            if pattern.search(text):
                return emotion
    return fallback


def should_attach_for_platform(
    platform: str, allowed: Iterable[str] | None = None
) -> bool:
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


def _load_watcher_adapter():
    """Import the watcher adapter, working both as a package and standalone."""
    try:
        from . import watcher_adapter as wa  # package import
    except ImportError:  # standalone load via spec_from_file_location
        import importlib.util as ilu

        spec = ilu.spec_from_file_location(
            "hent_ai_watcher_adapter", Path(__file__).resolve().parent / "watcher_adapter.py"
        )
        assert spec is not None and spec.loader is not None
        wa = ilu.module_from_spec(spec)
        spec.loader.exec_module(wa)
    return wa

def _build_watcher_llm():
    """Build the live LLM critic/generator/moderator, or None when unconfigured."""
    if not (os.getenv("HENT_AI_LLM_API_KEY") and os.getenv("HENT_AI_LLM_MODEL")):
        return None

    def _load(mod_name: str, file_name: str):
        try:
            import importlib

            return importlib.import_module(f".{mod_name}", __package__)
        except Exception:
            import importlib.util as ilu

            spec = ilu.spec_from_file_location(
                f"hent_ai_{mod_name}", Path(__file__).resolve().parent / file_name
            )
            assert spec is not None and spec.loader is not None
            module = ilu.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module

    watcher_llm = _load("watcher_llm", "watcher_llm.py")
    llm_client = _load("llm_client", "llm_client.py")
    return watcher_llm.create_watcher_llm(llm_client.call_chat, os.getenv("HENT_AI_WATCHER_PERSONA"))


class _WatcherLogger:
    """Adapter logger shim (info/warn) over the stdlib logger."""

    def __init__(self) -> None:
        import logging

        self._log = logging.getLogger("hent_ai.watcher")

    def info(self, *args: object) -> None:
        self._log.info(" ".join(str(a) for a in args))

    def warn(self, *args: object) -> None:
        self._log.warning(" ".join(str(a) for a in args))


def _watcher_config_from_env() -> dict | None:
    """Read watcher config from env; return None when disabled."""
    if os.getenv("HENT_AI_WATCHER_ENABLED", "").strip().lower() not in {"1", "true", "yes", "on"}:
        return None
    cfg: dict = {"enabled": True}
    shadow = os.getenv("HENT_AI_WATCHER_SHADOW")
    cfg["shadowMode"] = True if shadow is None else shadow.strip().lower() in {"1", "true", "yes", "on"}
    for env_name, key in (
        ("HENT_AI_WATCHER_COOLDOWN_MS", "cooldownMs"),
        ("HENT_AI_WATCHER_BUDGET_PER_HOUR", "budgetPerHour"),
    ):
        raw = os.getenv(env_name)
        if raw and raw.strip().lstrip("-").isdigit():
            cfg[key] = int(raw.strip())
    confidence = os.getenv("HENT_AI_WATCHER_CONFIDENCE")
    if confidence:
        try:
            cfg["confidenceThreshold"] = float(confidence.strip())
        except ValueError:
            pass
    return cfg


def _derive_scope(platform: str, kwargs: dict) -> str:
    """Prefer host session/thread ids; degrade to per-platform scope (MF4)."""
    return str(kwargs.get("session_id") or kwargs.get("thread_id") or f"platform:{platform}")


def register(ctx) -> None:
    """Register a single composed ``transform_llm_output`` hook.

    The composed path inlines an anti-fixation nudge into the response prose
    FIRST, then appends the emotion-image ``MEDIA:`` directive — never a second
    hook after MEDIA (which would corrupt media parsing). The watcher is opt-in
    via ``HENT_AI_WATCHER_ENABLED`` and shadow-first by default; without it this
    behaves exactly like the original emotion-image plugin.
    """

    watcher_cfg = _watcher_config_from_env()
    watcher = None
    if watcher_cfg is not None:
        wa = _load_watcher_adapter()
        watcher_deps = {
            "config": watcher_cfg,
            "logger": _WatcherLogger(),
            "isoNow": lambda: datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        watcher_llm = _build_watcher_llm()
        if watcher_llm is not None:
            watcher_deps["critic"] = watcher_llm["critic"]
            watcher_deps["generate"] = watcher_llm["generate"]
            watcher_deps["moderate"] = watcher_llm["moderate"]
        watcher = wa.create_hermes_watcher_adapter(watcher_deps)
        _compose_nudge = wa.compose_nudge

    def transform_llm_output(response_text: str, platform: str = "", **kwargs) -> str | None:
        base = response_text
        if watcher is not None and response_text and should_attach_for_platform(platform):
            try:
                scope = _derive_scope(platform, kwargs)
                nudge = watcher["on_agent_turn"](scope, response_text)
                if nudge:
                    base = _compose_nudge(response_text, nudge)
            except Exception:  # never let the watcher break the primary response
                base = response_text
        media = build_transformed_response(base, platform=platform)
        if media is not None:
            return media
        return base if base != response_text else None

    ctx.register_hook("transform_llm_output", transform_llm_output)
