# Claude Code

Verified with Claude Code 2.1.299 and herdr 0.8.2 (2026-10-14).

## Start

The brain runs as an interactive session in a herdr pane; herdr is the only runtime dependency
besides the agent itself. `kit/brain.sh start --agent claude` creates the `hent-brain` workspace,
starts Claude Code there with the restricted permissions below, and prompts it to register:

```
hent session set --agent claude --session-id <id> --cwd "$PWD"
```

herdr assigns a new Claude session its id (reported by `herdr agent start`); `kit/brain.sh` records
it, and `kit/brain.sh start --resume` continues it with `claude --resume <id>`. `hent session set`
takes the pane from `$HERDR_PANE_ID`. `kit/brain.sh stop` closes the workspace.

## How messages arrive

The bridge asks herdr whether the agent in the registered pane is idle (`herdr agent get`), checks
that the input line is empty (`herdr agent read`), submits one `[hent] INBOUND ...` line with
`herdr agent prompt`, and confirms it from the user record in the session transcript under
`~/.claude/projects/`. While the agent works, waits on a question, or the pane has no Claude Code,
messages stay queued in order. No hooks are needed.

## Restricted brain session (public channels)

`kit/brain.sh` starts Claude Code so it can only answer:

```
claude [--resume <id>] --permission-mode dontAsk \
  --allowedTools "Bash(hent send:*)" "Bash(hent skip:*)" "Bash(hent typing:*)" "Bash(hent history:*)" \
    "Bash(hent media:*)" "Bash(hent session set:*)" "Read(//$HOME/.hent/**)" "Read(//$HOME/.claude/skills/hent-mode/**)" "Skill" \
  --disallowedTools WebFetch WebSearch Write Edit NotebookEdit
```

`dontAsk` denies anything not listed without a prompt, so the pane never blocks. Absolute paths in
`Read(...)` rules need two leading slashes (`Read(//Users/me/.hent/**)`) or `~/`; a single leading
slash is relative to the settings file and silently matches nothing.
