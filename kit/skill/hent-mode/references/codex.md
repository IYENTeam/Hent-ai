# Codex

Verified with codex-cli 0.162.1 (2026-10-13).

## Install

`kit/install.sh` links the skill to `~/.codex/skills/hent-mode` (and `~/.agents/skills`). Start the
brain session inside tmux:

```
tmux new -s hent-brain
codex             # then: "hent mode"
```

The session id is the `thread_id` of the session (also in the newest rollout file name under
`~/.codex/sessions/`). Register:

```
hent session set --agent codex --session-id <id> --cwd "$PWD"
```

`hent` talks to `127.0.0.1` (bridge and service), so the sandbox must allow local network access:
`sandbox_workspace_write.network_access = true` in `~/.codex/config.toml`, or run with
`-s danger-full-access` if your policy allows it.

## How messages arrive

- Pane mode: one `[hent] INBOUND ...` line is typed into the pane and confirmed from the rollout
  file under `~/.codex/sessions/`.
- Headless mode: one resumed turn per message:

  ```
  codex exec resume --skip-git-repo-check -c sandbox_workspace_write.network_access=true <id> "<prompt>"
  ```

  `--skip-git-repo-check` is required outside a trusted directory. The turn counts as delivered only
  if it ends with `hent send --reply-to` or `hent skip`.

No hooks are needed.
