"""Hermes Agent plugin for Hent-ai emotion image attachments.

This module intentionally stays independent from the OpenClaw TypeScript plugin.
Hermes loads Python plugins from ``~/.hermes/plugins/<name>/`` and calls
``register(ctx)``. The plugin uses ``transform_llm_output`` so Hermes Gateway can
handle platform-specific media delivery through its existing ``MEDIA:<path>``
response directive.
"""

from __future__ import annotations

import importlib.util as importlib_util
import os
import sys
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path


def _load_watcher_runtime():
    try:
        from . import watcher_runtime
    except ImportError:
        spec = importlib_util.spec_from_file_location(
            "hent_ai_watcher_runtime", Path(__file__).resolve().parent / "watcher_runtime.py"
        )
        assert spec is not None and spec.loader is not None
        watcher_runtime = importlib_util.module_from_spec(spec)
        spec.loader.exec_module(watcher_runtime)
    return watcher_runtime


def _load_watcher_adapter():
    return _load_watcher_runtime().load_watcher_adapter()


def _load_service_adapter():
    try:
        from . import service_adapter
    except ImportError:
        spec = importlib_util.spec_from_file_location(
            "hent_ai_service_adapter", Path(__file__).resolve().parent / "service_adapter.py"
        )
        assert spec is not None and spec.loader is not None
        service_adapter = importlib_util.module_from_spec(spec)
        sys.modules[spec.name] = service_adapter
        try:
            spec.loader.exec_module(service_adapter)
        except Exception:
            sys.modules.pop(spec.name, None)
            raise
    return service_adapter


def _load_emotion_rules():
    spec = importlib_util.spec_from_file_location(
        "hent_ai_emotion_rules", Path(__file__).resolve().parent / "emotion_rules.py"
    )
    assert spec is not None and spec.loader is not None
    emotion_rules = importlib_util.module_from_spec(spec)
    sys.modules[spec.name] = emotion_rules
    try:
        spec.loader.exec_module(emotion_rules)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    return emotion_rules


def _build_watcher_llm():
    return _load_watcher_runtime().build_watcher_llm()


def _watcher_config_from_env() -> dict[str, object] | None:
    return _load_watcher_runtime().watcher_config_from_env()


_rules = _load_emotion_rules()
DEFAULT_EMOTION_MAP = _rules.DEFAULT_EMOTION_MAP
EMOTION_CONTRACT_VERSION = _rules.EMOTION_CONTRACT_VERSION
DEFAULT_EMOTION = _rules.DEFAULT_EMOTION
DEFAULT_SUPPORTED_PLATFORMS = _rules.DEFAULT_SUPPORTED_PLATFORMS
EMOTION_RULES = _rules.EMOTION_RULES


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

    return _rules.detect_emotion(text, fallback)


def should_attach_for_platform(
    platform: str, allowed: Iterable[str] | None = None
) -> bool:
    """Return whether a Hermes platform should receive image attachments."""

    return _rules.should_attach_for_platform(
        platform,
        allowed if allowed is not None else supported_platforms(),
    )


def build_transformed_response(
    response_text: str,
    *,
    platform: str,
    assets_dir: Path | None = None,
    emotion_map: dict[str, str] | None = None,
    hook_context: dict[str, object] | None = None,
    **hook_context_kwargs: object,
) -> str | None:
    """Build a Hermes response with a MEDIA directive, or ``None`` to skip.

    Hermes treats a non-empty string returned from ``transform_llm_output`` as a
    replacement response. Returning ``None`` leaves the original response
    unchanged.
    """

    sanitized_text = strip_media_directives(response_text)
    if not sanitized_text or not should_attach_for_platform(platform):
        return None

    active_hook_context = dict(hook_context or {})
    active_hook_context.update(hook_context_kwargs)
    service_adapter = _load_service_adapter()
    if service_adapter.service_token_configured():
        transformed = service_adapter.transformed_response(
            sanitized_text,
            platform=platform,
            hook_context=active_hook_context,
        )
        if transformed is not None:
            return transformed
        if sanitized_text != response_text.strip():
            return sanitized_text
        return None

    active_map = emotion_map or DEFAULT_EMOTION_MAP
    emotion = detect_emotion(sanitized_text)
    filename = active_map.get(emotion) or active_map.get(DEFAULT_EMOTION)
    if not filename:
        return None

    image_path = (assets_dir or resolve_assets_dir()) / filename
    if not image_path.exists():
        return None

    return f"{sanitized_text.rstrip()}\n\nMEDIA:{image_path.resolve()}"


def strip_media_directives(text: str) -> str:
    return _rules.strip_media_directives(text)


def register(ctx) -> None:
    """Register a single composed ``transform_llm_output`` hook.

    The composed path inlines an anti-fixation nudge into the response prose
    FIRST, then appends the emotion-image ``MEDIA:`` directive — never a second
    hook after MEDIA (which would corrupt media parsing). The watcher is opt-in
    via ``HENT_AI_WATCHER_ENABLED`` and shadow-first by default; without it this
    behaves exactly like the original emotion-image plugin.
    """

    watcher_runtime = _load_watcher_runtime()
    watcher_cfg = _watcher_config_from_env()
    watcher = None
    compose_nudge = None
    if watcher_cfg is not None:
        wa = _load_watcher_adapter()
        watcher_deps = {
            "config": watcher_cfg,
            "logger": watcher_runtime.WatcherLogger(),
            "isoNow": lambda: datetime.now(timezone.utc).isoformat(),
        }
        watcher_llm = _build_watcher_llm()
        if watcher_llm is not None:
            watcher_deps["critic"] = watcher_llm["critic"]
            watcher_deps["generate"] = watcher_llm["generate"]
            watcher_deps["moderate"] = watcher_llm["moderate"]
        watcher = wa.create_hermes_watcher_adapter(watcher_deps)
        compose_nudge = wa.compose_nudge

    def transform_llm_output(response_text: str, platform: str = "", **kwargs: object) -> str | None:
        base = response_text
        if watcher is not None and response_text and should_attach_for_platform(platform):
            try:
                scope = watcher_runtime.derive_scope(platform, kwargs)
                nudge = watcher["on_agent_turn"](scope, response_text)
                if nudge and compose_nudge is not None:
                    base = compose_nudge(response_text, nudge)
            except Exception:  # never let the watcher break the primary response
                base = response_text
        media = build_transformed_response(base, platform=platform, hook_context=kwargs)
        if media is not None:
            return media
        return base if base != response_text else None

    ctx.register_hook("transform_llm_output", transform_llm_output)
