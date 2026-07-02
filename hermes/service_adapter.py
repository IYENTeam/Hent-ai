from __future__ import annotations

import json
import mimetypes
import os
from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

VALID_EMOTIONS = ("sorry", "happy", "confused", "focused", "loyalty", "neutral")
CHANNEL_ID_KEYS = (
    "channel_id",
    "channelId",
    "channel",
    "chat_id",
    "chatId",
    "room_id",
    "roomId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
    "session_id",
    "sessionId",
)


@dataclass(frozen=True)
class ServiceConfig:
    __slots__ = ("base_url", "token", "cache_dir", "timeout_seconds")

    base_url: str
    token: str
    cache_dir: Path
    timeout_seconds: float


def config_from_env(env: Mapping[str, str] | None = None) -> ServiceConfig | None:
    source = os.environ if env is None else env
    token = _string_value(source.get("HENT_AI_SERVICE_TOKEN"))
    if not token:
        return None

    base_url = (_string_value(source.get("HENT_AI_SERVICE_URL")) or "http://127.0.0.1:8787").rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None

    cache_raw = _string_value(source.get("HENT_AI_HERMES_CACHE_DIR"))
    cache_dir = Path(cache_raw).expanduser() if cache_raw else Path.home() / ".cache" / "hent-ai" / "hermes-media"
    timeout_seconds = _timeout_seconds(source.get("HENT_AI_HERMES_SERVICE_TIMEOUT_MS"))

    return ServiceConfig(
        base_url=base_url,
        token=token,
        cache_dir=cache_dir,
        timeout_seconds=timeout_seconds,
    )


def service_token_configured(env: Mapping[str, str] | None = None) -> bool:
    source = os.environ if env is None else env
    return _string_value(source.get("HENT_AI_SERVICE_TOKEN")) is not None


def transformed_response(
    response_text: str,
    *,
    platform: str,
    hook_context: dict[str, object],
) -> str | None:
    config = config_from_env()
    if config is None:
        return None
    image_path = media_path_for_response(
        response_text,
        platform=platform,
        hook_context=hook_context,
        config=config,
    )
    if image_path is None:
        return None
    return f"{response_text.rstrip()}\n\nMEDIA:{image_path}"


def media_path_for_response(
    response_text: str,
    *,
    platform: str,
    hook_context: dict[str, object],
    config: ServiceConfig,
) -> Path | None:
    verdict_response = _post_json(
        config,
        "/v1/final-response/verdict",
        {
            "context": {
                "channelId": channel_id_from_context(hook_context),
                "content": response_text,
                "platform": platform,
                "validEmotions": list(VALID_EMOTIONS),
            }
        },
    )
    media = _media_from_verdict_response(verdict_response)
    if media is None:
        return None
    return _download_media(config, media)


def channel_id_from_context(hook_context: dict[str, object]) -> str | None:
    for key in CHANNEL_ID_KEYS:
        value = hook_context.get(key)
        normalized = _string_value(value)
        if normalized:
            return normalized
    return None


def _post_json(config: ServiceConfig, endpoint: str, body: dict[str, object]) -> dict[str, object] | None:
    try:
        request = Request(
            urljoin(f"{config.base_url}/", endpoint.lstrip("/")),
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {config.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        with urlopen(request, timeout=config.timeout_seconds) as response:
            if response.status < 200 or response.status >= 300:
                return None
            return _record_value(json.loads(response.read().decode("utf-8")))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def _media_from_verdict_response(response: dict[str, object] | None) -> dict[str, object] | None:
    if response is None:
        return None
    verdict = _record_value(response.get("verdict"))
    if verdict is None:
        return None
    media = _record_value(verdict.get("media"))
    if media is None:
        return None
    media_url = _string_value(media.get("url"))
    content_type = _string_value(media.get("contentType"))
    if not media_url or not (content_type or "").startswith("image/"):
        return None
    return media


def _download_media(config: ServiceConfig, media: dict[str, object]) -> Path | None:
    media_url = _media_url(config, media)
    if media_url is None:
        return None

    filename = _filename_for_media(media_url, media)
    target = config.cache_dir / filename
    if target.exists():
        return target.resolve()

    try:
        config.cache_dir.mkdir(parents=True, exist_ok=True)
        request = Request(
            media_url,
            headers={
                "Authorization": f"Bearer {config.token}",
                "Accept": "image/*",
            },
            method="GET",
        )
        with urlopen(request, timeout=config.timeout_seconds) as response:
            if response.status < 200 or response.status >= 300:
                return None
            response_type = response.headers.get("Content-Type", "")
            declared_type = _string_value(media.get("contentType")) or ""
            if response_type and not response_type.startswith("image/"):
                return None
            if not response_type and not declared_type.startswith("image/"):
                return None
            target.write_bytes(response.read())
            return target.resolve()
    except (HTTPError, URLError, TimeoutError, OSError):
        return None


def _media_url(config: ServiceConfig, media: dict[str, object]) -> str | None:
    raw_url = _string_value(media.get("url"))
    if not raw_url:
        return None
    absolute_url = urljoin(f"{config.base_url}/", raw_url)
    parsed_base = urlparse(config.base_url)
    parsed_media = urlparse(absolute_url)
    if parsed_media.scheme not in {"http", "https"} or not parsed_media.netloc:
        return None
    if (parsed_media.scheme, parsed_media.netloc) != (parsed_base.scheme, parsed_base.netloc):
        return None
    return absolute_url


def _filename_for_media(media_url: str, media: dict[str, object]) -> str:
    storage_key = _string_value(_mapping_value(media.get("metadata"), "storageKey"))
    cache_key = sha256(f"{media_url}\n{storage_key or ''}".encode("utf-8")).hexdigest()
    declared = _string_value(media.get("filename"))
    suffix = Path(declared or urlparse(media_url).path).suffix
    if not suffix:
        suffix = mimetypes.guess_extension(_string_value(media.get("contentType")) or "") or ".img"
    return f"{cache_key}{suffix}"


def _record_value(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    return {key: item for key, item in value.items() if isinstance(key, str)}


def _mapping_value(value: object, key: str) -> object | None:
    record = _record_value(value)
    return record.get(key) if record is not None else None


def _string_value(value: object) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, int):
        return str(value)
    return None


def _timeout_seconds(raw: str | None) -> float:
    if not raw:
        return 5.0
    try:
        timeout_ms = int(raw)
    except ValueError:
        return 5.0
    return max(0.1, min(timeout_ms / 1000, 30.0))
