"""Tests for the Hermes Hent-ai plugin (``hermes/__init__.py``)."""

from __future__ import annotations

import importlib
import json
import os
import re
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# Ensure the repo root is on sys.path so we can import the plugin
_this_dir = Path(__file__).resolve().parent
_repo_root = _this_dir.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

# Import the hermes package (hermes/__init__.py) via importlib to avoid
# confusion between package and __init__ module.
hentai = importlib.import_module("hermes")


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_mock_http_response(data: dict[str, Any], status: int = 200) -> MagicMock:
    """Create a mock ``urllib.request.urlopen`` context manager response."""
    raw = json.dumps(data).encode("utf-8")
    mock_resp = MagicMock(spec=BytesIO)
    mock_resp.read.return_value = raw
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = None
    return mock_resp


def _patch_urlopen(mock_response: MagicMock) -> Any:
    """Patch ``urllib.request.urlopen`` to return a canned response."""
    return patch.object(hentai.urllib.request, "urlopen", return_value=mock_response)


def _patch_urlopen_error(error: Exception) -> Any:
    """Patch ``urllib.request.urlopen`` to raise an error."""
    return patch.object(hentai.urllib.request, "urlopen", side_effect=error)


# ═══════════════════════════════════════════════════════════════════════════════
# LLM Classifier
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetLLMConfig:
    def test_returns_config_when_env_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        config = hentai._get_llm_config()
        assert config is not None
        assert config["model"] == "gpt-4"
        assert config["api_key"] == "sk-test"
        assert config["base_url"] == "https://api.openai.com/v1"

    def test_returns_config_with_custom_base_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        monkeypatch.setenv("HENT_AI_LLM_BASE_URL", "https://custom.example.com/v1")
        config = hentai._get_llm_config()
        assert config is not None
        assert config["base_url"] == "https://custom.example.com/v1"

    def test_returns_none_when_model_missing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HENT_AI_LLM_MODEL", raising=False)
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        assert hentai._get_llm_config() is None

    def test_returns_none_when_api_key_missing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.delenv("HENT_AI_LLM_API_KEY", raising=False)
        assert hentai._get_llm_config() is None

    def test_strips_trailing_slash_from_base_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        monkeypatch.setenv("HENT_AI_LLM_BASE_URL", "https://api.openai.com/v1/")
        config = hentai._get_llm_config()
        assert config is not None
        assert config["base_url"] == "https://api.openai.com/v1"


class TestIsAnthropicModel:
    def test_detects_claude(self) -> None:
        assert hentai._is_anthropic_model("claude-3-5-sonnet") is True
        assert hentai._is_anthropic_model("anthropic/claude-3-opus") is True

    def test_rejects_openai(self) -> None:
        assert hentai._is_anthropic_model("gpt-4") is False
        assert hentai._is_anthropic_model("openai/gpt-5.4-mini") is False


class TestCallLLMApi:
    def test_openai_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        mock_resp = _make_mock_http_response(
            {"choices": [{"message": {"content": "happy"}}]}
        )
        with _patch_urlopen(mock_resp):
            result = hentai._call_llm_api(
                {"model": "gpt-4", "api_key": "sk-test", "base_url": "https://api.openai.com/v1"},
                "test prompt",
            )
        assert result == "happy"

    def test_openai_no_choices(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        mock_resp = _make_mock_http_response({"choices": []})
        with _patch_urlopen(mock_resp):
            result = hentai._call_llm_api(
                {"model": "gpt-4", "api_key": "sk-test", "base_url": "https://api.openai.com/v1"},
                "test prompt",
            )
        assert result is None

    def test_anthropic_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "claude-3-sonnet")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-ant-test")
        mock_resp = _make_mock_http_response(
            {"content": [{"text": " sorry  "}]}
        )
        with _patch_urlopen(mock_resp):
            result = hentai._call_llm_api(
                {"model": "claude-3-sonnet", "api_key": "sk-ant-test", "base_url": "https://api.anthropic.com/v1"},
                "test prompt",
            )
        assert result == "sorry"

    def test_anthropic_empty_content(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "claude-3-sonnet")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-ant-test")
        mock_resp = _make_mock_http_response({"content": [{"text": ""}]})
        with _patch_urlopen(mock_resp):
            result = hentai._call_llm_api(
                {"model": "claude-3-sonnet", "api_key": "sk-ant-test", "base_url": "https://api.anthropic.com/v1"},
                "test prompt",
            )
        assert result is None

    def test_returns_none_on_http_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        with _patch_urlopen_error(hentai.urllib.error.HTTPError(
            "http://example.com", 401, "Unauthorized", {}, None
        )):
            result = hentai._call_llm_api(
                {"model": "gpt-4", "api_key": "sk-test", "base_url": "https://api.openai.com/v1"},
                "test prompt",
            )
        assert result is None

    def test_returns_none_on_connection_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        with _patch_urlopen_error(hentai.urllib.error.URLError("connection failed")):
            result = hentai._call_llm_api(
                {"model": "gpt-4", "api_key": "sk-test", "base_url": "https://api.openai.com/v1"},
                "test prompt",
            )
        assert result is None

    def test_openai_request_has_no_temperature(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Verify temperature is NOT sent (reasoning-model compatibility)."""
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")

        sent_body: dict[str, Any] = {}

        def capture_request(req: Any, *args: Any, **kwargs: Any) -> MagicMock:
            nonlocal sent_body
            sent_body = json.loads(req.data.decode("utf-8"))
            return _make_mock_http_response(
                {"choices": [{"message": {"content": "happy"}}]}
            )

        with patch.object(hentai.urllib.request, "urlopen", side_effect=capture_request):
            hentai._call_llm_api(
                {"model": "gpt-4", "api_key": "sk-test", "base_url": "https://api.openai.com/v1"},
                "test prompt",
            )

        assert "temperature" not in sent_body, (
            f"temperature should NOT be sent; got body={sent_body}"
        )


class TestExtractEmotion:
    def setup_method(self) -> None:
        self.valid = ["happy", "neutral", "sorry", "confused", "focused"]

    def test_exact_match(self) -> None:
        assert hentai.extract_emotion("happy", self.valid) == "happy"

    def test_whitespace_padded(self) -> None:
        assert hentai.extract_emotion("  happy  ", self.valid) == "happy"

    def test_case_insensitive(self) -> None:
        assert hentai.extract_emotion("HAPPY", self.valid) == "happy"
        assert hentai.extract_emotion("Sorry", self.valid) == "sorry"

    def test_multi_line(self) -> None:
        assert hentai.extract_emotion("thinking...\nhappy\ndone", self.valid) == "happy"

    def test_quoted(self) -> None:
        assert hentai.extract_emotion('"focused"', self.valid) == "focused"
        assert hentai.extract_emotion("'neutral'", self.valid) == "neutral"

    def test_word_boundary_fallback(self) -> None:
        assert hentai.extract_emotion("I am feeling happy today!", self.valid) == "happy"
        assert hentai.extract_emotion("This is confused by the error", self.valid) == "confused"

    def test_returns_none_for_unrelated_text(self) -> None:
        assert hentai.extract_emotion("lorem ipsum dolor sit amet", self.valid) is None

    def test_returns_none_for_empty(self) -> None:
        assert hentai.extract_emotion("", self.valid) is None
        assert hentai.extract_emotion(None, self.valid) is None

    def test_returns_none_for_whitespace_only(self) -> None:
        assert hentai.extract_emotion("   \n  ", self.valid) is None

    def test_unquoted_smart_quotes(self) -> None:
        assert hentai.extract_emotion("\u201csorry\u201d", self.valid) == "sorry"
        assert hentai.extract_emotion("\u2018focused\u2019", self.valid) == "focused"


class TestClassifyEmotionWithLLM:
    def test_returns_emotion_on_openai_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        mock_resp = _make_mock_http_response(
            {"choices": [{"message": {"content": "confused"}}]}
        )
        with _patch_urlopen(mock_resp):
            result = hentai.classify_emotion_with_llm(
                "I don't understand this error",
                ["happy", "neutral", "sorry", "confused", "focused"],
            )
        assert result == "confused"

    def test_returns_none_when_not_configured(self) -> None:
        # No env vars set
        result = hentai.classify_emotion_with_llm(
            "Great work!",
            ["happy", "neutral"],
        )
        assert result is None

    def test_returns_none_on_api_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")
        with _patch_urlopen_error(hentai.urllib.error.URLError("timeout")):
            result = hentai.classify_emotion_with_llm(
                "Great work!",
                ["happy", "neutral"],
            )
        assert result is None

    def test_anthropic_flow(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "claude-3-sonnet")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-ant-test")
        mock_resp = _make_mock_http_response(
            {"content": [{"text": "focused"}]}
        )
        with _patch_urlopen(mock_resp):
            result = hentai.classify_emotion_with_llm(
                "I'm debugging the issue",
                ["happy", "neutral", "focused"],
            )
        assert result == "focused"

    def test_llm_prompt_includes_correct_emotions(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Verify the prompt sent to LLM references all valid emotions."""
        monkeypatch.setenv("HENT_AI_LLM_MODEL", "gpt-4")
        monkeypatch.setenv("HENT_AI_LLM_API_KEY", "sk-test")

        sent_body: dict[str, Any] = {}

        def capture_request(req: Any, *args: Any, **kwargs: Any) -> MagicMock:
            nonlocal sent_body
            sent_body = json.loads(req.data.decode("utf-8"))
            return _make_mock_http_response(
                {"choices": [{"message": {"content": "happy"}}]}
            )

        with patch.object(hentai.urllib.request, "urlopen", side_effect=capture_request):
            hentai.classify_emotion_with_llm("done!", ["happy", "neutral", "sorry"])

        user_msg: str = sent_body["messages"][0]["content"]
        assert '"happy"' in user_msg
        assert '"neutral"' in user_msg
        assert '"sorry"' in user_msg
        assert '"loyalty"' not in user_msg  # Should NOT include removed emotion


# ═══════════════════════════════════════════════════════════════════════════════
# Manifest System
# ═══════════════════════════════════════════════════════════════════════════════


class TestLoadManifest:
    def test_loads_valid_manifest(self, tmp_path: Path) -> None:
        manifest = {
            "version": 1,
            "activeSet": "gothic-v1",
            "sets": {
                "gothic-v1": {
                    "name": "Test Set",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "emotions": {"happy": ["happy.png"]},
                }
            },
        }
        manifest_file = tmp_path / "manifest.json"
        manifest_file.write_text(json.dumps(manifest), encoding="utf-8")

        loaded = hentai.load_manifest(tmp_path)
        assert loaded is not None
        assert loaded["activeSet"] == "gothic-v1"

    def test_returns_none_when_missing(self, tmp_path: Path) -> None:
        assert hentai.load_manifest(tmp_path) is None

    def test_returns_none_on_malformed_json(self, tmp_path: Path) -> None:
        manifest_file = tmp_path / "manifest.json"
        manifest_file.write_text("not valid json", encoding="utf-8")
        assert hentai.load_manifest(tmp_path) is None


class TestGetActiveSet:
    def test_returns_active_set(self) -> None:
        manifest: hentai.AssetManifest = {
            "version": 1,
            "activeSet": "s1",
            "sets": {
                "s1": {
                    "name": "Set 1",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "emotions": {"happy": ["happy.png"]},
                }
            },
        }
        result = hentai.get_active_set(manifest)
        assert result is not None
        set_id, set_data = result
        assert set_id == "s1"
        assert set_data["name"] == "Set 1"

    def test_returns_none_when_active_set_empty(self) -> None:
        manifest: hentai.AssetManifest = {
            "version": 1,
            "activeSet": "",
            "sets": {},
        }
        assert hentai.get_active_set(manifest) is None

    def test_returns_none_when_set_not_found(self) -> None:
        manifest: hentai.AssetManifest = {
            "version": 1,
            "activeSet": "nonexistent",
            "sets": {},
        }
        assert hentai.get_active_set(manifest) is None


class TestBuildEmotionMapFromSet:
    def test_builds_map(self) -> None:
        set_data: hentai.AssetSet = {
            "name": "Test",
            "createdAt": "2026-01-01T00:00:00Z",
            "emotions": {
                "happy": ["happy.png"],
                "neutral": ["neutral.png"],
            },
        }
        result = hentai.build_emotion_map_from_set("my-set", set_data)
        assert result == {
            "happy": "sets/my-set/happy.png",
            "neutral": "sets/my-set/neutral.png",
        }

    def test_skips_empty_emotions(self) -> None:
        set_data: hentai.AssetSet = {
            "name": "Test",
            "createdAt": "2026-01-01T00:00:00Z",
            "emotions": {
                "happy": [],
                "neutral": ["neutral.png"],
            },
        }
        result = hentai.build_emotion_map_from_set("my-set", set_data)
        assert "happy" not in result
        assert result["neutral"] == "sets/my-set/neutral.png"

    def test_uses_first_file_only(self) -> None:
        set_data: hentai.AssetSet = {
            "name": "Test",
            "createdAt": "2026-01-01T00:00:00Z",
            "emotions": {
                "happy": ["happy.png", "happy-v2.png"],
            },
        }
        result = hentai.build_emotion_map_from_set("my-set", set_data)
        assert result["happy"] == "sets/my-set/happy.png"


# ═══════════════════════════════════════════════════════════════════════════════
# Channel Overrides
# ═══════════════════════════════════════════════════════════════════════════════


class TestLoadChannelOverrides:
    def test_loads_valid_overrides(self, tmp_path: Path) -> None:
        overrides = {"123": "private", "456": "gothic"}
        overrides_file = tmp_path / "channel-overrides.json"
        overrides_file.write_text(json.dumps(overrides), encoding="utf-8")
        assert hentai.load_channel_overrides(tmp_path) == overrides

    def test_returns_empty_when_missing(self, tmp_path: Path) -> None:
        assert hentai.load_channel_overrides(tmp_path) == {}

    def test_returns_empty_on_malformed_json(self, tmp_path: Path) -> None:
        overrides_file = tmp_path / "channel-overrides.json"
        overrides_file.write_text("not json", encoding="utf-8")
        assert hentai.load_channel_overrides(tmp_path) == {}


class TestSaveChannelOverrides:
    def test_writes_overrides_file(self, tmp_path: Path) -> None:
        overrides: hentai.ChannelOverrides = {"111": "private", "222": "gothic"}
        hentai.save_channel_overrides(tmp_path, overrides)
        saved = tmp_path / "channel-overrides.json"
        assert saved.exists()
        content = json.loads(saved.read_text(encoding="utf-8"))
        assert content == overrides

    def test_overwrites_existing_file(self, tmp_path: Path) -> None:
        initial = {"111": "private"}
        (tmp_path / "channel-overrides.json").write_text(
            json.dumps(initial), encoding="utf-8"
        )
        updated = {"111": "default"}
        hentai.save_channel_overrides(tmp_path, updated)
        content = json.loads(
            (tmp_path / "channel-overrides.json").read_text(encoding="utf-8")
        )
        assert content == updated

    def test_writes_empty_dict(self, tmp_path: Path) -> None:
        hentai.save_channel_overrides(tmp_path, {})
        saved = tmp_path / "channel-overrides.json"
        assert saved.exists()
        content = json.loads(saved.read_text(encoding="utf-8"))
        assert content == {}

    def test_output_is_pretty_printed_json(self, tmp_path: Path) -> None:
        overrides = {"111": "private"}
        hentai.save_channel_overrides(tmp_path, overrides)
        raw = (tmp_path / "channel-overrides.json").read_text(encoding="utf-8")
        # Check for indentation (pretty-print) and trailing newline
        assert '  "' in raw
        assert raw.endswith("\n")


# ═══════════════════════════════════════════════════════════════════════════════
# Private Mode Switching
# ═══════════════════════════════════════════════════════════════════════════════


class TestHandleModeCommand:
    def test_private_mode_on(self, tmp_path: Path) -> None:
        changed, msg, mode = hentai.handle_mode_command(
            "private mode on", "111", tmp_path
        )
        assert changed is True
        assert msg is not None
        assert mode == "private"
        overrides = hentai.load_channel_overrides(tmp_path)
        assert overrides.get("111") == "private"

    def test_private_mode_korean(self, tmp_path: Path) -> None:
        changed, msg, mode = hentai.handle_mode_command(
            "프라이빗 모드 켜줘", "111", tmp_path
        )
        assert changed is True
        assert mode == "private"
        overrides = hentai.load_channel_overrides(tmp_path)
        assert overrides.get("111") == "private"

    def test_private_mode_mixed(self, tmp_path: Path) -> None:
        changed, msg, mode = hentai.handle_mode_command(
            "private 모드 켜", "111", tmp_path
        )
        assert changed is True
        assert mode == "private"

    def test_private_mode_off(self, tmp_path: Path) -> None:
        # Set up existing override
        hentai.save_channel_overrides(tmp_path, {"111": "private"})
        changed, msg, mode = hentai.handle_mode_command(
            "private off", "111", tmp_path
        )
        assert changed is True
        assert mode == "default"
        overrides = hentai.load_channel_overrides(tmp_path)
        assert "111" not in overrides

    def test_normal_mode_korean(self, tmp_path: Path) -> None:
        hentai.save_channel_overrides(tmp_path, {"111": "private"})
        changed, msg, mode = hentai.handle_mode_command(
            "일반 모드로 돌아가", "111", tmp_path
        )
        assert changed is True
        assert mode == "default"

    def test_normal_mode_english(self, tmp_path: Path) -> None:
        hentai.save_channel_overrides(tmp_path, {"111": "private"})
        changed, msg, mode = hentai.handle_mode_command(
            "normal mode please", "111", tmp_path
        )
        assert changed is True
        assert mode == "default"

    def test_set_to_named_set(self, tmp_path: Path) -> None:
        changed, msg, mode = hentai.handle_mode_command(
            "set to gothic-v1", "111", tmp_path
        )
        assert changed is True
        assert mode == "gothic-v1"
        overrides = hentai.load_channel_overrides(tmp_path)
        assert overrides.get("111") == "gothic-v1"

    def test_korean_set_mode(self, tmp_path: Path) -> None:
        changed, msg, mode = hentai.handle_mode_command(
            "gothic 모드로 바꿔줘", "111", tmp_path
        )
        assert changed is True
        assert mode == "gothic"
        overrides = hentai.load_channel_overrides(tmp_path)
        assert overrides.get("111") == "gothic"

    def test_no_match_returns_false(self, tmp_path: Path) -> None:
        changed, msg, mode = hentai.handle_mode_command(
            "hello how are you", "111", tmp_path
        )
        assert changed is False
        assert msg is None
        assert mode is None

    def test_empty_text_returns_false(self, tmp_path: Path) -> None:
        changed, msg, mode = hentai.handle_mode_command("", "111", tmp_path)
        assert changed is False

    def test_empty_channel_id_returns_false(self, tmp_path: Path) -> None:
        changed, msg, mode = hentai.handle_mode_command(
            "private mode on", "", tmp_path
        )
        assert changed is False


# ═══════════════════════════════════════════════════════════════════════════════
# Channel Filtering
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetChannelFilter:
    def test_returns_empty_when_not_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HENT_AI_CHANNEL_MODE", raising=False)
        monkeypatch.delenv("HENT_AI_CHANNEL_LIST", raising=False)
        mode, channel_set = hentai._get_channel_filter()
        assert mode == ""
        assert channel_set == set()

    def test_allowlist(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_CHANNEL_MODE", "allowlist")
        monkeypatch.setenv("HENT_AI_CHANNEL_LIST", "111,222,333")
        mode, channel_set = hentai._get_channel_filter()
        assert mode == "allowlist"
        assert channel_set == {"111", "222", "333"}

    def test_blocklist(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_CHANNEL_MODE", "blocklist")
        monkeypatch.setenv("HENT_AI_CHANNEL_LIST", "999")
        mode, channel_set = hentai._get_channel_filter()
        assert mode == "blocklist"
        assert channel_set == {"999"}


class TestIsChannelEnabled:
    def test_enabled_when_no_filter(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HENT_AI_CHANNEL_MODE", raising=False)
        monkeypatch.delenv("HENT_AI_CHANNEL_LIST", raising=False)
        assert hentai.is_channel_enabled("111") is True

    def test_allowlist_allows_matching(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_CHANNEL_MODE", "allowlist")
        monkeypatch.setenv("HENT_AI_CHANNEL_LIST", "111,222")
        assert hentai.is_channel_enabled("111") is True
        assert hentai.is_channel_enabled("222") is True

    def test_allowlist_blocks_non_matching(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_CHANNEL_MODE", "allowlist")
        monkeypatch.setenv("HENT_AI_CHANNEL_LIST", "111")
        assert hentai.is_channel_enabled("999") is False

    def test_blocklist_blocks_matching(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_CHANNEL_MODE", "blocklist")
        monkeypatch.setenv("HENT_AI_CHANNEL_LIST", "111")
        assert hentai.is_channel_enabled("111") is False

    def test_blocklist_allows_non_matching(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_CHANNEL_MODE", "blocklist")
        monkeypatch.setenv("HENT_AI_CHANNEL_LIST", "111")
        assert hentai.is_channel_enabled("222") is True

    def test_disabled_for_empty_channel_id(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HENT_AI_CHANNEL_MODE", raising=False)
        monkeypatch.delenv("HENT_AI_CHANNEL_LIST", raising=False)
        assert hentai.is_channel_enabled("") is False


# ═══════════════════════════════════════════════════════════════════════════════
# Rate Limiter
# ═══════════════════════════════════════════════════════════════════════════════


class TestRateLimiter:
    def test_allows_initial_generation(self) -> None:
        limiter = hentai.RateLimiter(limit=5)
        assert limiter.can_generate() is True
        assert limiter.remaining == 5

    def test_blocks_when_limit_reached(self) -> None:
        limiter = hentai.RateLimiter(limit=3)
        for _ in range(3):
            limiter.record_generation()
        assert limiter.can_generate() is False
        assert limiter.remaining == 0

    def test_reports_correct_remaining(self) -> None:
        limiter = hentai.RateLimiter(limit=10)
        for _ in range(4):
            limiter.record_generation()
        assert limiter.remaining == 6

    def test_resets_after_window_expiry(self) -> None:
        """Verify the counter resets when the hour window expires."""
        limiter = hentai.RateLimiter(limit=5)
        # Exhaust the limiter (count = limit)
        limiter._count = 5
        assert limiter.can_generate() is False  # rate limited

        # Move window start 4000s into the past (past the 3600s window)
        limiter._window_start -= 4000
        # _reset_if_needed() runs inside can_generate() -> resets count to 0
        assert limiter.can_generate() is True
        assert limiter.remaining == 5

    def test_limit_property(self) -> None:
        limiter = hentai.RateLimiter(limit=42)
        assert limiter.limit == 42


# ═══════════════════════════════════════════════════════════════════════════════
# Emotion Detection (Regex Fallback)
# ═══════════════════════════════════════════════════════════════════════════════


class TestDetectEmotion:
    def test_detects_happy(self) -> None:
        assert hentai.detect_emotion("Task completed successfully!") == "happy"
        assert hentai.detect_emotion("I fixed the bug! Great!") == "happy"
        assert hentai.detect_emotion("shipped!") == "happy"

    def test_detects_sorry(self) -> None:
        assert hentai.detect_emotion("Sorry about that mistake.") == "sorry"
        assert hentai.detect_emotion("I apologize for the error.") == "sorry"
        assert hentai.detect_emotion("my bad, let me fix it") == "sorry"

    def test_detects_confused(self) -> None:
        assert hentai.detect_emotion("I'm not sure what caused this.") == "confused"
        assert hentai.detect_emotion("This is strange and unexpected.") == "confused"
        assert hentai.detect_emotion("How do we handle this?") == "confused"

    def test_detects_focused(self) -> None:
        assert hentai.detect_emotion("I'm investigating the root cause.") == "focused"
        assert hentai.detect_emotion("Currently debugging the issue.") == "focused"
        assert hentai.detect_emotion("in progress, checking logs") == "focused"

    def test_falls_back_to_default(self) -> None:
        assert hentai.detect_emotion("Hello, how are you?") == "neutral"
        assert hentai.detect_emotion("") == "neutral"

    def test_no_longer_detects_loyalty(self) -> None:
        """Loyalty has been removed from the rules."""
        assert hentai.detect_emotion("Got it, understood!") == "neutral"  # not "loyalty"
        assert hentai.detect_emotion("Yes sir, will do!") == "neutral"  # not "loyalty"

    def test_loyalty_not_in_default_map(self) -> None:
        assert "loyalty" not in hentai.DEFAULT_EMOTION_MAP


# ═══════════════════════════════════════════════════════════════════════════════
# Emotion Map Resolution
# ═══════════════════════════════════════════════════════════════════════════════


class TestResolveEmotionMapForChannel:
    def test_uses_defaults_when_no_manifest(self, tmp_path: Path) -> None:
        result = hentai._resolve_emotion_map_for_channel(tmp_path, None)
        assert result == hentai.DEFAULT_EMOTION_MAP

    def test_applies_manifest_active_set(self, tmp_path: Path) -> None:
        manifest: hentai.AssetManifest = {
            "version": 1,
            "activeSet": "s1",
            "sets": {
                "s1": {
                    "name": "S1",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "emotions": {"happy": ["happy.png"]},
                }
            },
        }
        result = hentai._resolve_emotion_map_for_channel(tmp_path, manifest)
        assert result["happy"] == "sets/s1/happy.png"
        # Non-overridden emotions still use defaults
        assert result["neutral"] == "neutral.png"

    def test_applies_channel_override(self, tmp_path: Path) -> None:
        manifest: hentai.AssetManifest = {
            "version": 1,
            "activeSet": "default",
            "sets": {
                "default": {
                    "name": "Default",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "emotions": {"happy": ["happy.png"]},
                },
                "private": {
                    "name": "Private",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "emotions": {"happy": ["happy.png"]},
                },
            },
        }
        # Write channel override
        overrides = {"111": "private"}
        (tmp_path / "channel-overrides.json").write_text(
            json.dumps(overrides), encoding="utf-8"
        )

        result = hentai._resolve_emotion_map_for_channel(tmp_path, manifest, channel_id="111")
        assert result["happy"] == "sets/private/happy.png"

    def test_channel_override_uses_active_set_when_no_override(self, tmp_path: Path) -> None:
        manifest: hentai.AssetManifest = {
            "version": 1,
            "activeSet": "default",
            "sets": {
                "default": {
                    "name": "Default",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "emotions": {"happy": ["happy.png"]},
                },
            },
        }
        result = hentai._resolve_emotion_map_for_channel(tmp_path, manifest, channel_id="999")
        # No override for 999, uses manifest active set
        assert result["happy"] == "sets/default/happy.png"


# ═══════════════════════════════════════════════════════════════════════════════
# Response Transformation
# ═══════════════════════════════════════════════════════════════════════════════


class TestBuildTransformedResponse:
    def test_skips_empty_response(self) -> None:
        result = hentai.build_transformed_response("", platform="discord")
        assert result is None

    def test_skips_no_reply(self) -> None:
        result = hentai.build_transformed_response("NO_REPLY", platform="discord")
        assert result is None
        result = hentai.build_transformed_response("  NO_REPLY  ", platform="discord")
        assert result is None

    def test_skips_unsupported_platform(self) -> None:
        result = hentai.build_transformed_response("Hello", platform="unknown")
        assert result is None

    def test_returns_media_when_image_found(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Create a fake asset directory with emotion images
        assets_dir = tmp_path / "assets"
        assets_dir.mkdir()
        (assets_dir / "happy.png").write_text("fake-image-data")
        (assets_dir / "neutral.png").write_text("fake-image-data")

        monkeypatch.setattr(hentai, "resolve_assets_dir", lambda: assets_dir)

        result = hentai.build_transformed_response(
            "Task complete! Great job!",
            platform="discord",
        )
        assert result is not None
        # Should contain MEDIA: directive with a path to happy.png
        assert "MEDIA:" in result
        assert "happy.png" in result

    def test_defaults_to_neutral_when_no_match(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        assets_dir = tmp_path / "assets"
        assets_dir.mkdir()
        (assets_dir / "neutral.png").write_text("fake-image-data")

        monkeypatch.setattr(hentai, "resolve_assets_dir", lambda: assets_dir)

        result = hentai.build_transformed_response(
            "Hello, how can I help?",
            platform="discord",
        )
        assert result is not None
        assert "neutral.png" in result

    def test_returns_none_when_image_not_found(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        assets_dir = tmp_path / "assets"
        assets_dir.mkdir()
        monkeypatch.setattr(hentai, "resolve_assets_dir", lambda: assets_dir)

        result = hentai.build_transformed_response(
            "All done!",
            platform="discord",
        )
        assert result is None

    def test_respects_rate_limit(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        assets_dir = tmp_path / "assets"
        assets_dir.mkdir()
        (assets_dir / "happy.png").write_text("fake-image-data")
        (assets_dir / "neutral.png").write_text("fake-image-data")

        monkeypatch.setattr(hentai, "resolve_assets_dir", lambda: assets_dir)
        monkeypatch.setattr(hentai, "_get_global_rate_limiter", lambda: hentai.RateLimiter(limit=0))

        result = hentai.build_transformed_response(
            "Task complete!",
            platform="discord",
        )
        assert result is None

    def test_channel_filtering_integration(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Channel filtering is handled in the hook, not build_transformed_response."""
        # Ensure no real assets are found by using a tmp empty dir
        monkeypatch.setattr(hentai, "resolve_assets_dir", lambda: tmp_path)
        monkeypatch.setenv("HENT_AI_CHANNEL_MODE", "blocklist")
        monkeypatch.setenv("HENT_AI_CHANNEL_LIST", "111")

        # Build the hook function
        hooks: dict[str, Any] = {}

        class FakeCtx:
            def register_hook(self, name: str, fn: Any) -> None:
                hooks[name] = fn

        hentai.register(FakeCtx())
        hook_fn = hooks["transform_llm_output"]

        # Blocked channel should skip (hook returns None before calling build)
        result = hook_fn("Task complete!", platform="discord", channel_id="111")
        assert result is None

        # Non-blocked channel hits build_transformed_response which finds no images -> None
        result = hook_fn("Task complete!", platform="discord", channel_id="222")
        assert result is None

    def test_explicit_emotion_map_used(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        assets_dir = tmp_path / "assets"
        assets_dir.mkdir()
        (assets_dir / "custom.png").write_text("fake-image-data")

        monkeypatch.setattr(hentai, "resolve_assets_dir", lambda: assets_dir)

        result = hentai.build_transformed_response(
            "Great!",
            platform="discord",
            emotion_map={"happy": "custom.png", "neutral": "neutral.png"},
        )
        assert result is not None
        assert "custom.png" in result

    def test_manifest_based_path_resolution(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Verify manifest paths like 'sets/gothic-v1/happy.png' resolve correctly."""
        assets_dir = tmp_path / "assets"
        sets_dir = assets_dir / "sets" / "gothic-v1"
        sets_dir.mkdir(parents=True)
        (sets_dir / "happy.png").write_text("fake-image-data")

        # Create manifest
        (assets_dir / "manifest.json").write_text(
            json.dumps({
                "version": 1,
                "activeSet": "gothic-v1",
                "sets": {
                    "gothic-v1": {
                        "name": "Test",
                        "createdAt": "2026-01-01T00:00:00Z",
                        "emotions": {"happy": ["happy.png"]},
                    }
                },
            }),
            encoding="utf-8",
        )

        monkeypatch.setattr(hentai, "resolve_assets_dir", lambda: assets_dir)

        result = hentai.build_transformed_response(
            "Great job!",
            platform="discord",
        )
        assert result is not None
        assert "sets/gothic-v1/happy.png" in result


# ═══════════════════════════════════════════════════════════════════════════════
# Platform Support
# ═══════════════════════════════════════════════════════════════════════════════


class TestShouldAttachForPlatform:
    def test_attaches_for_default_platforms(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HENT_AI_HERMES_PLATFORMS", raising=False)
        assert hentai.should_attach_for_platform("discord") is True
        assert hentai.should_attach_for_platform("telegram") is True
        assert hentai.should_attach_for_platform("slack") is True

    def test_skips_unknown_platforms(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HENT_AI_HERMES_PLATFORMS", raising=False)
        assert hentai.should_attach_for_platform("custom") is False

    def test_wildcard_allows_all(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HENT_AI_HERMES_PLATFORMS", "*")
        assert hentai.should_attach_for_platform("any-platform") is True

    def test_rejects_empty_platform(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HENT_AI_HERMES_PLATFORMS", raising=False)
        assert hentai.should_attach_for_platform("") is False

    def test_custom_allowed_set(self) -> None:
        assert hentai.should_attach_for_platform("discord", allowed=["discord"]) is True
        assert hentai.should_attach_for_platform("telegram", allowed=["discord"]) is False


# ═══════════════════════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════════════════════


class TestConstants:
    def test_loyalty_removed_from_default_map(self) -> None:
        """Feature #6: 'loyalty' has been removed from DEFAULT_EMOTION_MAP."""
        assert "loyalty" not in hentai.DEFAULT_EMOTION_MAP

    def test_loyalty_removed_from_emotion_rules(self) -> None:
        """Feature #6: no rule for 'loyalty' in EMOTION_RULES."""
        for emotion, _ in hentai.EMOTION_RULES:
            assert emotion != "loyalty", "loyalty should be removed from EMOTION_RULES"

    def test_final_emotions(self) -> None:
        """Verify the final set of emotions."""
        expected = {"happy", "neutral", "sorry", "confused", "focused"}
        assert set(hentai.DEFAULT_EMOTION_MAP.keys()) == expected


# ═══════════════════════════════════════════════════════════════════════════════
# Plugin Registration
# ═══════════════════════════════════════════════════════════════════════════════


class TestRegister:
    def test_registers_transform_hook(self) -> None:
        hooks: dict[str, Any] = {}

        class FakeCtx:
            def register_hook(self, name: str, fn: Any) -> None:
                hooks[name] = fn

        hentai.register(FakeCtx())

        assert "transform_llm_output" in hooks
        assert callable(hooks["transform_llm_output"])

    def test_hook_returns_none_for_blocked_channel(self, monkeypatch: pytest.MonkeyPatch) -> None:
        hooks: dict[str, Any] = {}

        class FakeCtx:
            def register_hook(self, name: str, fn: Any) -> None:
                hooks[name] = fn

        hentai.register(FakeCtx())
        monkeypatch.setenv("HENT_AI_CHANNEL_MODE", "allowlist")
        monkeypatch.setenv("HENT_AI_CHANNEL_LIST", "111")

        result = hooks["transform_llm_output"](
            "Hello", platform="discord", channel_id="999"
        )
        assert result is None

    def test_hook_passes_kwargs(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Verify arbitrary kwargs don't break the hook."""
        # Point to empty tmp dir so no real assets are found
        monkeypatch.setattr(hentai, "resolve_assets_dir", lambda: tmp_path)

        hooks: dict[str, Any] = {}

        class FakeCtx:
            def register_hook(self, name: str, fn: Any) -> None:
                hooks[name] = fn

        hentai.register(FakeCtx())

        # Should not raise even with unexpected kwargs
        result = hooks["transform_llm_output"](
            "Hello", platform="discord", channel_id="111",
            extra_arg="test", user_id="123",
        )
        assert result is None
