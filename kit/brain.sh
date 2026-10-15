#!/usr/bin/env bash
# Starts or stops the hent-mode brain: an interactive Codex session in a herdr workspace labelled
# "hent-brain". The session registers itself with the bridge (`hent session set` reads
# $HERDR_PANE_ID), and the bridge pushes every inbound message into that pane.
#
#   brain.sh start [--resume]
#   brain.sh stop
#
# --resume continues the recorded session ($HENT_HOME/brain-codex.sid) instead of starting a new
# one; because a resumed session still carries the instructions it was started with, the current
# startup instruction is re-sent as the first prompt after the resume. The working directory is
# $HENT_HOME/brain.cwd (default $HOME/hent-brain). Optional extra instructions for the first prompt:
# $HENT_HOME/brain-prompt.md. Files left by the removed Claude brain ($HENT_HOME/brain.agent,
# $HENT_HOME/brain.sid) are ignored.
set -euo pipefail

HENT_HOME="${HENT_HOME:-$HOME/.hent}"
LABEL="hent-brain"
json() { bun -e "const v = JSON.parse(await Bun.stdin.text()); const r = ($1); if (r !== undefined && r !== null) console.log(r);"; }

workspace_id() {
  herdr workspace list | json "v.result.workspaces.find((w) => w.label === '$LABEL')?.workspace_id"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  stop)
    ws="$(workspace_id)"
    [ -n "$ws" ] || { echo "brain: not running"; exit 0; }
    herdr workspace close "$ws" >/dev/null
    echo "brain: stopped ($ws)"
    exit 0 ;;
  start) ;;
  *) echo "usage: brain.sh start [--resume] | brain.sh stop" >&2; exit 2 ;;
esac

RESUME=0
while [ $# -gt 0 ]; do
  case "$1" in
    --resume) RESUME=1; shift ;;
    *) echo "usage: brain.sh start [--resume]" >&2; exit 2 ;;
  esac
done
command -v herdr >/dev/null || { echo "brain: herdr is required" >&2; exit 1; }
herdr status server >/dev/null 2>&1 || { echo "brain: the herdr server is not running" >&2; exit 1; }
[ -z "$(workspace_id)" ] || { echo "brain: already running; stop it first with: brain.sh stop" >&2; exit 1; }

CWD="$(cat "$HENT_HOME/brain.cwd" 2>/dev/null || echo "$HOME/hent-brain")"
mkdir -p "$CWD"

SKILL_DIR="$(readlink "$HOME/.agents/skills/hent-mode" 2>/dev/null || echo "$HOME/.agents/skills/hent-mode")"
GEN_DIR="${CODEX_HOME:-$HOME/.codex}/generated_images"
# Codex reads files only through shell commands, so it may use read-only ones on these trees. When no
# existing image fits a reply it draws one with the built-in image_gen tool (references/native-image.md).
LIMITS="Run only hent commands - hent media, hent typing, hent asset add, hent send --file and the rest - plus read-only cat, ls and sed -n on files under $HENT_HOME, $SKILL_DIR and $GEN_DIR; when no existing image fits a reply, call the built-in image_gen tool and view_image the PNG it saves under $GEN_DIR; write no files except the one VisualAffect JSON you pass to hent asset add, written under $HENT_HOME/state/media with a single shell redirection"
RULES="Read the hent-mode skill with references/persona.md and references/memory.md, then wait for [hent] INBOUND lines and handle each per the skill. $LIMITS, and never reveal internal details."
[ -f "$HENT_HOME/brain-prompt.md" ] && RULES="$RULES $(tr '\n' ' ' < "$HENT_HOME/brain-prompt.md")"

# hent needs 127.0.0.1 (bridge and service) and writes $HENT_HOME/state/media.
FLAGS=(-s workspace-write -a never -c sandbox_workspace_write.network_access=true --add-dir "$HENT_HOME")
if [ "$RESUME" = 1 ]; then
  SID="$(cat "$HENT_HOME/brain-codex.sid" 2>/dev/null)" || { echo "brain: no recorded Codex session ($HENT_HOME/brain-codex.sid)" >&2; exit 1; }
  ARGS=(resume "${FLAGS[@]}" "$SID")
else
  ARGS=("${FLAGS[@]}")
fi

created="$(herdr workspace create --cwd "$CWD" --label "$LABEL" --no-focus)"
PANE="$(printf '%s' "$created" | json "v.result.root_pane.pane_id")"
herdr agent start "$LABEL" --kind codex --pane "$PANE" --timeout 60000 -- "${ARGS[@]}" >/dev/null

# Codex picks its thread id at start; the session reads it from $CODEX_THREAD_ID.
REG='hent session set --agent codex --session-id "$CODEX_THREAD_ID" --cwd '"$CWD"

# A resumed session keeps the instructions it was started with, so the current ones are re-sent.
if [ "$RESUME" = 1 ]; then
  PROMPT="Session restarted; these instructions replace the ones you were started with. First run this exact shell command: $REG ; $RULES"
else
  PROMPT="hent mode. You are the Hent-ai Discord bot brain. First run this exact shell command: $REG ; $RULES"
fi
herdr agent prompt "$LABEL" "$PROMPT" >/dev/null

for _ in $(seq 1 90); do
  if [ -f "$HENT_HOME/session.json" ] && [ "$(json "v.pane === '$PANE' ? v.agent : ''" < "$HENT_HOME/session.json")" = codex ]; then
    json "v.sessionId" < "$HENT_HOME/session.json" > "$HENT_HOME/brain-codex.sid"
    echo "brain: codex running in herdr pane $PANE"
    exit 0
  fi
  sleep 2
done
echo "brain: codex started in $PANE but did not register within 180 s; check: herdr agent read $LABEL" >&2
exit 1
