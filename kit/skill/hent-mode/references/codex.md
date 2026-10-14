# Codex

Verified with codex-cli 0.162.1 and herdr 0.8.2 (2026-10-14).

## Start

`kit/brain.sh start --agent codex` creates the `hent-brain` herdr workspace and starts Codex with:

```
codex -s workspace-write -a never -c sandbox_workspace_write.network_access=true --add-dir ~/.hent
```

`hent` talks to `127.0.0.1` (bridge and service), so the sandbox needs network access, and
`hent media` writes `~/.hent/state/media`. Codex has no per-command allowlist; the start prompt
limits it to `hent` commands. Codex picks its thread id at start and exposes it as
`$CODEX_THREAD_ID`, so the session registers with:

```
hent session set --agent codex --session-id "$CODEX_THREAD_ID" --cwd "$PWD"
```

`kit/brain.sh` records the id for `kit/brain.sh start --resume` (`codex resume <id>`).

## How messages arrive

Same as Claude Code: herdr reports the agent idle, the input line is empty, `herdr agent prompt`
submits one `[hent] INBOUND ...` line, and the user record in the rollout file under
`~/.codex/sessions/` confirms it. No hooks are needed.
