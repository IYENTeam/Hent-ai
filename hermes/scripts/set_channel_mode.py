#!/usr/bin/env python3
"""Hermes CLI mode switcher for Hent-ai per-channel emotion-image set selection.

Usage:
    python hermes/scripts/set_channel_mode.py --channel <ID> --mode <set-id|default> [--image-dir <path>]

Examples:
    python hermes/scripts/set_channel_mode.py --channel 123456789 --mode private
    python hermes/scripts/set_channel_mode.py --channel 123456789 --mode default
    python hermes/scripts/set_channel_mode.py --channel 123456789 --mode gothic-v1
    python hermes/scripts/set_channel_mode.py --channel 123456789 --mode private \\
        --image-dir /path/to/assets

Environment variables:
    HENT_AI_ASSET_DIR   Alternative to ``--image-dir``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Ensure the repo root is importable so we can import the hermes package.
_script_dir = Path(__file__).resolve().parent
_repo_root = _script_dir.parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from hermes import load_channel_overrides, save_channel_overrides  # noqa: E402


def resolve_assets_dir(image_dir: str | None) -> Path:
    """Resolve the assets directory from CLI args or environment, with
    a default of ``../../assets`` relative to the script location."""
    cli_path = Path(image_dir).expanduser().resolve() if image_dir else None
    if cli_path:
        return cli_path

    env_override = _get_env_asset_dir()
    if env_override:
        return env_override

    # Default: ../../assets relative to script (hermes/scripts/ -> assets/)
    return _repo_root / "assets"


def _get_env_asset_dir() -> Path | None:
    """Read ``HENT_AI_ASSET_DIR`` from environment if set."""
    try:
        import os

        val = os.environ.get("HENT_AI_ASSET_DIR")
        if val:
            return Path(val).expanduser().resolve()
    except ImportError:
        pass
    return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Set the emotion-image set for a Discord channel.",
    )
    parser.add_argument(
        "--channel",
        required=True,
        help="Discord channel ID (numeric snowflake).",
    )
    parser.add_argument(
        "--mode",
        required=True,
        help=(
            "Set ID to activate (e.g. 'private', 'gothic-v1'), "
            "or 'default' to revert to the manifest's active set."
        ),
    )
    parser.add_argument(
        "--image-dir",
        default=None,
        help=(
            "Path to the assets directory containing manifest.json and "
            "channel-overrides.json. Defaults to ../../assets relative to "
            "the script, or HENT_AI_ASSET_DIR."
        ),
    )

    args = parser.parse_args()

    assets_dir = resolve_assets_dir(args.image_dir)
    overrides = load_channel_overrides(assets_dir)

    if args.mode == "default":
        overrides.pop(args.channel, None)
        sys.stderr.write(f"Channel {args.channel}: reverted to default set\n")
    else:
        overrides[args.channel] = args.mode
        sys.stderr.write(f'Channel {args.channel}: set to "{args.mode}"\n')

    save_channel_overrides(assets_dir, overrides)
    overrides_path = assets_dir / "channel-overrides.json"
    print(f"Saved to {overrides_path.resolve()}")


if __name__ == "__main__":
    main()
