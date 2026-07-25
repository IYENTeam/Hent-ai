# ADR-0001: Separate Discord ambient worker from the HTTP API

- Status: accepted
- Date: 2026-07-24
- Owner approval: recorded in the approved `adaptive-ambient-discord-participant` plan and draft

## Decision

`service/src/main.ts` is the API-only entrypoint. It opens the Hent-ai HTTP service and never imports or starts a Discord participant worker. `service/src/discord-ambient-worker.ts` is the only participant entrypoint. The two processes share the service SQLite WAL database.

The worker is opt-in and fail-closed. `HENT_AI_DISCORD_PARTICIPANT_ENABLED=true` and a strict startup-only `HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST` are required. The allowlist is comma-separated `guildId:channelId` Snowflake pairs. Each pair must also have an enabled service channel mapping; a mapped profile must exist when one is selected. Persona precedence is channel profile `soulSnippet`, then `HENT_AI_CONVERSATION_PERSONA`, then the generic service persona. Missing mappings are skipped. If no eligible scope remains, the worker opens no Discord connection.

The worker also requires `HENT_AI_SERVICE_DB_PATH`, `HENT_AI_DISCORD_BOT_TOKEN`, and OpenAI-compatible appraisal provider endpoint, token, and model. `ServiceDatabase` at that path is the service runtime profile/channel SSOT; `ProfileDatabase` remains a legacy/generation migration concern, not the participant runtime database. It has no environment Discord API-base override. Production uses Discord API v10; loopback base URLs are constructor-only test seams. Logs are structured and never include tokens.

Each allowed guild/channel gets its own lease key, so one worker process can own multiple scopes without a channel releasing another channel's fence. Scope leases and claimed work both last 30 seconds and renew every 10 seconds with their original fence token. The runtime rechecks the current enabled mapping, abort signal, fence, and work claim after roster load, immediately before provider dispatch, and before outcome mutation. The archive owner has a separate lease: an archive-only owner may call the configured provider without any participant scope lease, but only for an exact startup-allowlisted Discord scope whose current service mapping is enabled; it makes zero Discord API calls. This approved topology does not mean zero all network. Provider calls remain outside transactions. Shutdown aborts the shared controller first, cancels heartbeats and poll timers, stops archive owners and cores, then waits active work, releases matching fences, and closes SQLite.

## Retention and autonomy

Guild/user relationships are bounded and idempotent. Membership v1 uses complete paged guild rosters; active humans are recent (10-minute) non-bot authors intersected with a fresh complete roster. First polling seeds a cursor without replying; later work is durable. Raw events are marked archived after 14 days, while raw events and source-linked summaries remain permanently: neither is deleted.

Ambient participation is continuous and probabilistic. A normal request for silence is social transcript evidence: the model may accept, ignore, resist, or escalate. It must never become deterministic mute, quit, or quiet-until state. Only operational kill switches, lease loss, disabled mappings, and invalid startup configuration are deterministic. Delivery uses one to five typed bubbles, bounded length delay, durable nonces/receipts, and cancels remaining bubbles on newer human ingress.

## Live QA

The bot-token QA guild/channel pair is a fixture and documentation-only live-QA target, not production configuration. Local loopback wire tests are the proof of human Discord ingress. Conditional live QA validates bot egress using synthetic durable work in a temporary DB and cleans up created bot messages.

## Consequences

Operators start exactly one role per process. The former `server-with-poller.ts` helper is legacy watcher-poller composition and is not an API or participant-worker entrypoint.
