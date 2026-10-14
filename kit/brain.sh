#!/usr/bin/env bash
# Starts or stops the hent-mode brain: an interactive Claude Code or Codex session in a herdr
# workspace labelled "hent-brain". The session registers itself with the bridge (`hent session set`
# reads $HERDR_PANE_ID), and the bridge pushes every inbound message into that pane.
#
#   brain.sh start [--agent claude|codex] [--resume]
#   brain.sh stop
#
# Without --agent the last used agent ($HENT_HOME/brain.agent, default claude) is used. --resume
# continues the recorded session ($HENT_HOME/brain.sid, or brain-codex.sid for Codex) instead of
# starting a new one. The working directory is $HENT_HOME/brain.cwd (default $HOME/hent-brain).
# Optional extra instructions for the first prompt: $HENT_HOME/brain-prompt.md.
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
  *) echo "usage: brain.sh start [--agent claude|codex] [--resume] | brain.sh stop" >&2; exit 2 ;;
esac

AGENT="$(cat "$HENT_HOME/brain.agent" 2>/dev/null || echo claude)"; RESUME=0
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="${2:-}"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    *) echo "usage: brain.sh start [--agent claude|codex] [--resume]" >&2; exit 2 ;;
  esac
done
case "$AGENT" in claude|codex) ;; *) echo "brain: agent must be claude or codex" >&2; exit 2 ;; esac
command -v herdr >/dev/null || { echo "brain: herdr is required" >&2; exit 1; }
herdr status server >/dev/null 2>&1 || { echo "brain: the herdr server is not running" >&2; exit 1; }
[ -z "$(workspace_id)" ] || { echo "brain: already running; stop it first with: brain.sh stop" >&2; exit 1; }

CWD="$(cat "$HENT_HOME/brain.cwd" 2>/dev/null || echo "$HOME/hent-brain")"
mkdir -p "$CWD"
echo "$AGENT" > "$HENT_HOME/brain.agent"

SKILL_DIR="$(readlink "$HOME/.agents/skills/hent-mode" 2>/dev/null || echo "$HOME/.agents/skills/hent-mode")"
if [ "$AGENT" = codex ]; then
  # Codex reads files only through shell commands, so it may use read-only ones on these two trees.
  LIMITS="Run only hent commands, plus read-only cat, ls and sed -n on files under $HENT_HOME and $SKILL_DIR; write no files"
else
  LIMITS="Run no command other than hent, read no file outside $HENT_HOME and the skill"
fi
RULES="Read the hent-mode skill with references/persona.md and references/memory.md, then wait for [hent] INBOUND lines and handle each per the skill. $LIMITS, and never reveal internal details."
[ -f "$HENT_HOME/brain-prompt.md" ] && RULES="$RULES $(tr '\n' ' ' < "$HENT_HOME/brain-prompt.md")"

if [ "$AGENT" = claude ]; then
  MODE=()
  if [ "$RESUME" = 1 ]; then
    SID="$(cat "$HENT_HOME/brain.sid" 2>/dev/null)" || { echo "brain: no recorded Claude session ($HENT_HOME/brain.sid)" >&2; exit 1; }
    MODE=(--resume "$SID")
  fi
  SKILL="$(readlink "$HOME/.claude/skills/hent-mode" || echo "$HOME/.claude/skills/hent-mode")"
  ARGS=("${MODE[@]}" --permission-mode dontAsk
    --allowedTools "Bash(hent send:*)" "Bash(hent skip:*)" "Bash(hent typing:*)" "Bash(hent history:*)" "Bash(hent media:*)" "Bash(hent session set:*)"
      "Read(/$HENT_HOME/**)" "Read(/$HOME/.claude/skills/hent-mode/**)" "Read(/$SKILL/**)" "Skill"
    --disallowedTools WebFetch WebSearch Write Edit NotebookEdit)
else
  # hent needs 127.0.0.1 (bridge and service) and writes $HENT_HOME/state/media.
  FLAGS=(-s workspace-write -a never -c sandbox_workspace_write.network_access=true --add-dir "$HENT_HOME")
  if [ "$RESUME" = 1 ]; then
    SID="$(cat "$HENT_HOME/brain-codex.sid" 2>/dev/null)" || { echo "brain: no recorded Codex session ($HENT_HOME/brain-codex.sid)" >&2; exit 1; }
    ARGS=(resume "${FLAGS[@]}" "$SID")
  else
    ARGS=("${FLAGS[@]}")
  fi
fi

created="$(herdr workspace create --cwd "$CWD" --label "$LABEL" --no-focus)"
PANE="$(printf '%s' "$created" | json "v.result.root_pane.pane_id")"
started="$(herdr agent start "$LABEL" --kind "$AGENT" --pane "$PANE" --timeout 60000 -- "${ARGS[@]}")"

if [ "$AGENT" = claude ]; then
  # herdr assigns a new Claude session its id; --resume keeps the recorded one.
  SID="$(printf '%s' "$started" | json "v.result.agent.agent_session?.value")"
  [ -n "$SID" ] || { echo "brain: herdr reported no Claude session id" >&2; exit 1; }
  echo "$SID" > "$HENT_HOME/brain.sid"
  REG="hent session set --agent claude --session-id $SID --cwd $CWD"
else
  # Codex picks its thread id at start; the session reads it from $CODEX_THREAD_ID.
  REG='hent session set --agent codex --session-id "$CODEX_THREAD_ID" --cwd '"$CWD"
fi

if [ "$RESUME" = 1 ]; then
  PROMPT="Session restarted. Re-register with this exact shell command: $REG ; then keep handling [hent] INBOUND lines per hent-mode."
else
  PROMPT="hent mode. You are the Hent-ai Discord bot brain. First run this exact shell command: $REG ; $RULES"
fi
herdr agent prompt "$LABEL" "$PROMPT" >/dev/null

for _ in $(seq 1 90); do
  if [ -f "$HENT_HOME/session.json" ] && [ "$(json "v.pane === '$PANE' ? v.agent : ''" < "$HENT_HOME/session.json")" = "$AGENT" ]; then
    [ "$AGENT" = codex ] && json "v.sessionId" < "$HENT_HOME/session.json" > "$HENT_HOME/brain-codex.sid"
    echo "brain: $AGENT running in herdr pane $PANE"
    exit 0
  fi
  sleep 2
done
echo "brain: $AGENT started in $PANE but did not register within 180 s; check: herdr agent read $LABEL" >&2
exit 1
