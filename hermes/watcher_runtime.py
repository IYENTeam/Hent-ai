from __future__ import annotations

import datetime
import importlib
import importlib.util as importlib_util
import logging
import os
from pathlib import Path
from types import ModuleType
from typing import Protocol


class WatcherAdapter(Protocol):
    def __getitem__(self, key: str):
        ...


def _load_module(mod_name: str, file_name: str) -> ModuleType:
    if __package__:
        try:
            return importlib.import_module(f".{mod_name}", __package__)
        except ImportError:
            pass
    spec = importlib_util.spec_from_file_location(
        f"hent_ai_{mod_name}", Path(__file__).resolve().parent / file_name
    )
    assert spec is not None and spec.loader is not None
    module = importlib_util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_watcher_adapter() -> ModuleType:
    return _load_module("watcher_adapter", "watcher_adapter.py")


def build_watcher_llm():
    if not (os.getenv("HENT_AI_LLM_API_KEY") and os.getenv("HENT_AI_LLM_MODEL")):
        return None
    watcher_llm = _load_module("watcher_llm", "watcher_llm.py")
    llm_client = _load_module("llm_client", "llm_client.py")
    return watcher_llm.create_watcher_llm(llm_client.call_chat, os.getenv("HENT_AI_WATCHER_PERSONA"))


class WatcherLogger:
    def __init__(self) -> None:
        self._log = logging.getLogger("hent_ai.watcher")

    def info(self, *args: object) -> None:
        self._log.info(" ".join(str(arg) for arg in args))

    def warn(self, *args: object) -> None:
        self._log.warning(" ".join(str(arg) for arg in args))


def watcher_config_from_env() -> dict | None:
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


def create_watcher_from_env():
    watcher_cfg = watcher_config_from_env()
    if watcher_cfg is None:
        return None, None

    watcher_adapter = load_watcher_adapter()
    watcher_deps = {
        "config": watcher_cfg,
        "logger": WatcherLogger(),
        "isoNow": lambda: datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    watcher_llm = build_watcher_llm()
    if watcher_llm is not None:
        watcher_deps["critic"] = watcher_llm["critic"]
        watcher_deps["generate"] = watcher_llm["generate"]
        watcher_deps["moderate"] = watcher_llm["moderate"]
    return watcher_adapter.create_hermes_watcher_adapter(watcher_deps), watcher_adapter.compose_nudge


def derive_scope(platform: str, kwargs: dict) -> str:
    return str(kwargs.get("session_id") or kwargs.get("thread_id") or f"platform:{platform}")
