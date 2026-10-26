# Codex

Verified with codex-cli 0.162.1 and herdr 0.8.2 (2026-10-15).

## Start

`kit/brain.sh start` creates the `hent-brain` herdr workspace and starts Codex with:

```
codex --remote unix:// -C ~/hent-brain -s workspace-write -a never -c sandbox_workspace_write.network_access=true
```

`hent` talks to `127.0.0.1` (bridge and service), so the sandbox needs network access, and
`hent media` writes `~/.hent/state/media`. Explicit remote startup rejects both `--add-dir`
and `sandbox_workspace_write.writable_roots`. The first registration command therefore uses
`--configure-codex`: the bridge updates this already-running thread's subsequent turns through
`thread/settings/update`, retaining workspace-write and network access and adding HENT_HOME
as a writable root. Only after that succeeds does it register with the bridge, so no inbox wake
can race the permission setup. It neither starts another thread nor changes daemon-wide settings.
Codex has no per-command allowlist; the start prompt limits it to `hent` commands.
Codex picks its thread id at start and exposes it as
`$CODEX_THREAD_ID`. The startup script supplies per-thread HENT_HOME, bridge port, PATH and pane
environment settings; a shared daemon does not inherit a newly created pane's environment.
It passes the pane explicitly when the session registers:

```
hent session set --agent codex --session-id "$CODEX_THREAD_ID" --cwd "$PWD" --pane "$HERDR_PANE_ID" --configure-codex
```

`kit/brain.sh` records the id for `kit/brain.sh start --resume` (`codex resume <id>`).

## How messages arrive

The bridge connects to `$CODEX_HOME/app-server-control/app-server-control.sock` (default
`~/.codex/...`) using Codex's native WebSocket RPC. A small `[hent] WAKE <id>` input is queued
through `thread/queue/add`; message bodies stay in the bridge journal. Busy turns are not steered.
The session runs `hent inbox next --wake <id>`, replies or skips each event, then runs
`hent inbox done --wake <id>` until `continue` is false.

Herdr is checked only for the registered pane's lifetime. Delivery never reads terminal pixels,
types message bodies, scans rollout files, starts a headless session, or resumes an unloaded one.
On reconnect, the bridge reconciles its saved wake with the native queue. Native client IDs do not
deduplicate adds, so queue acceptance alone never marks an inbox event handled.

`codex app-server daemon version` reports whether the shared daemon is running. `brain.sh start`
uses Codex's idempotent daemon-start command and never restarts a daemon used by other sessions.
