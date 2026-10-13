# Claude Code

Verified with Claude Code 2.1.281 (2026-10-13).

## Install

`kit/install.sh` links the skill to `~/.claude/skills/hent-mode`. Start the brain session inside tmux
so the bridge can push into the live pane:

```
tmux new -s hent-brain
claude            # then: "hent mode"
```

Find your session id with `/status` (or the newest `~/.claude/projects/<cwd-slug>/<id>.jsonl`) and
register:

```
hent session set --agent claude --session-id <id> --cwd "$PWD"
```

Allow the `hent` command once (`/permissions` -> allow `Bash(hent:*)`) so replies never wait on a
prompt.

## How messages arrive

- Pane mode: the bridge types one `[hent] INBOUND ...` line into the pane and confirms it from the
  session transcript under `~/.claude/projects/`.
- Headless mode (no live pane): the bridge runs one resumed turn per message:

  ```
  claude -p --resume <id> "<prompt>" --allowedTools="Bash(hent:*)"
  ```

  `--allowedTools` takes a variable number of values, so the `=` form is required; otherwise the
  prompt is swallowed as a tool name. The bridge spawns it with stdin closed because `-p` reads
  stdin. The turn counts as delivered only if it ends with `hent send --reply-to` or `hent skip`.

No hooks are needed.
