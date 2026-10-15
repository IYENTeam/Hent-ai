#!/usr/bin/env bash
# Installs the Hent-ai session kit: links the hent-mode skill for every agent that is present and
# puts `hent` on PATH with `bun link`. Safe to run more than once.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$KIT_DIR/skill/hent-mode"

if ! command -v bun >/dev/null 2>&1; then
  echo "hent install: bun 1.3+ is required (https://bun.sh)" >&2
  exit 1
fi

link_skill() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  local target="$dir/hent-mode"
  if [ -L "$target" ] || [ ! -e "$target" ]; then
    ln -sfn "$SKILL_SRC" "$target"
    echo "linked $target"
  else
    echo "skipped $target (exists and is not a symlink)"
  fi
}

mkdir -p "$HOME/.agents/skills"
link_skill "$HOME/.agents/skills"
link_skill "$HOME/.codex/skills"

(cd "$KIT_DIR/cli" && bun install --frozen-lockfile >/dev/null && bun link >/dev/null)
mkdir -p "$HOME/.hent" && chmod 700 "$HOME/.hent"
echo "hent installed: $(command -v hent || echo "$HOME/.bun/bin/hent")"
