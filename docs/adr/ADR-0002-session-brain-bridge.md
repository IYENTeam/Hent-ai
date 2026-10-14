# ADR-0002: Session brain with a token-owning bridge

- Status: accepted
- Date: 2026-10-13
- Supersedes: [ADR-0001](ADR-0001-discord-ambient-worker-topology.md)
- Plan: `.omo/plans/session-owned-messenger.md`
- Contract code: `kit/cli/src/bridge/contract.ts` (types, strict parsers, constants)

## Decision

Three roles, three processes, each owning one thing:

| Role | Owns | Never does |
| --- | --- | --- |
| `hent bridge` (always-on, launchd) | The Discord token, the gateway connection, the inbound journal, outbound sends, push delivery into the session | Call the Hent-ai service, decide whether or what to reply, log message content or the token |
| Session (Claude Code or Codex, restartable) | Every conversational decision: whether to speak, what to say, the response affect | Read the Discord token, hold a Discord connection |
| Hent-ai service (optional) | Media verdicts, assets, profiles, channel mappings/settings, generation jobs | Hold a Discord token, call `discord.com`, run conversation/watcher/ambient logic, run a verifier |

The bridge is deliberately dumb: it is the only Hent-ai component that holds the token, and its job is connection, journal and delivery. The session is the brain. The service is an image picker that `hent send` asks under one shared 2000 ms deadline and skips on any failure, so the reply always goes out (IS-4, IS-8).

The ADR-0001 topology (an ambient worker inside the service with its own token, provider appraisal and drive model) is retired. Its speaking, budget and anti-repetition rules move into skill guidance (`kit/skill/hent-mode/references/conversation.md`); its database tables stay, with no DROP.

## Token

The bridge reads `~/.hent/discord.token`, which must be mode 0600 or the bridge refuses it. Optional sources: macOS Keychain only when `HENT_TOKEN_SOURCE=keychain` (an ssh login cannot unlock it), then `HENT_DISCORD_TOKEN` (tests). With no token the bridge logs `BRIDGE_NO_TOKEN` and retries every 60 s instead of exiting. No endpoint ever returns the token. `~/.hent` dirs are 0700 and files 0600, because the journal holds message content.

## Inbound journal and delivery

- `~/.hent/state/inbox.jsonl` is append-only, one `InboxEvent` per line, `seq` strictly increasing, fsync per append, 7-day retention compaction at start.
- First start per channel seeds at the channel's newest message and journals nothing older, so the session never answers what OpenClaw already handled.
- The bot's own messages are journaled with `authorIsSelf: true` and never injected.
- A `message_delete` is journaled only when the original message is in the journal; it copies that message's author fields, with empty `content`. `createdAt` is the event time: creation for `message_create`, edit time for `message_update`, observation time for `message_delete`.
- Delivery to the session is push (bridge `deliver.ts`), at-least-once, one event at a time in `seq` order. An injected event stays pending-handling until the session marks it handled, implicitly through `POST /v1/send` with `replyToMessageId`, or explicitly through `POST /v1/handled` (`hent skip`). On `POST /v1/session` (a session restart), and when a pane-delivered event is still unhandled 10 min later with the pane gone, every pending-handling event is re-injected once, in order. The skill dedupes by `messageId`.
- The inbox long-poll API exists for debugging and backfill only (`hent inbox --tail`); it is not the delivery path.

## Local API

`127.0.0.1` only, port 8789 (`HENT_BRIDGE_PORT`). Every endpoint except `GET /v1/health` requires `Authorization: Bearer <~/.hent/bridge.secret>`; the secret is created mode 0600 on first start and is not a messenger token.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /v1/inbox` | `consumer` (`[A-Za-z0-9_-]{1,64}`, also the cursor file name), `wait` integer seconds 0-25 (default 0), `ack` last handled `seq` (optional), `takeover=1` (optional) | `{events: InboxEvent[] (max 100), cursor}` |
| `GET /v1/history` | `channelId`, `limit` 1-100 (default 50) | `{events: InboxEvent[]}`, newest last |
| `POST /v1/send` | JSON `{channelId, text, replyToMessageId?, nonce}`, or multipart with field `payload` (the same JSON as a string) and field `file` | `{messageId}` |
| `POST /v1/edit` | `{channelId, messageId, text}` | `{messageId}` |
| `POST /v1/typing` | `{channelId}` | `204` |
| `POST /v1/handled` | `{messageId, how: "replied" \| "skipped"}` | `204` |
| `POST /v1/session` | `{agent: "claude" \| "codex", sessionId, pane, cwd}` (`pane` is a herdr pane id) | `204`; writes `~/.hent/session.json` and re-injects pending-handling events |
| `GET /v1/health` | none | `{gateway: "connected" \| "reconnecting" \| "fatal", botUserId \| null, lastSeq, consumers: [{name, cursor, leaseExpiresAt \| null}]}` |

Rules the parsers enforce:

- Request bodies and queries are strict: unknown or duplicated keys are rejected with `400 {error: "invalid_request", message}`. Response parsers (used by the CLI) ignore unknown keys so the bridge can add fields without breaking older CLIs.
- IDs (`channelId`, `messageId`, ...) match `[A-Za-z0-9_-]{1,64}`: Discord snowflakes in production, readable names in fixtures, and never anything that can alter a REST path.
- `text` is at most 2000 characters (one Discord message; `hent send` chunks before calling the bridge). JSON sends need non-empty text; a multipart send may have empty text because the file is the content. The file is at most 8 MiB.
- `pane` is a herdr pane id (`w1:p3`); `cwd` is an absolute path. The brain is always an interactive agent in a herdr pane (2026-10-14: the tmux and headless paths were removed; herdr reports the agent state and submits prompts).

### Cursor and lease (inbox)

`GET /v1/inbox` first advances the consumer cursor to `ack` and only then long-polls for events with `seq > cursor`. Advancing is monotonic and clamped: `advanceCursor(current, ack, lastSeq)` never moves the cursor backwards, ignores an `ack` at or below it, and never moves it past the last journaled `seq` (an ack from a future the journal has not reached would silently skip events). The inbox is a debugging surface (delivery is push, see below), so it has no holder identity: a consumer is exclusive only while one of its long-polls is in flight, and a second concurrent poll for the same consumer gets `409 {error: "lease_held"}` unless `takeover=1`. `consumers[].leaseExpiresAt` in `/v1/health` reports when the last poll's 60 s window ends; it is informational and does not block a later poll.

### Send idempotency and nonces

A base nonce is `[A-Za-z0-9_]{1,22}` (no `-`). Chunk `i` of a multi-message reply uses `<nonce>-<i>`, at most 25 characters, which is Discord's nonce limit. The bridge accepts either form on `/v1/send`. It keeps a sent-ledger `~/.hent/state/sent.jsonl` keyed by nonce: a repeated nonce returns the original `messageId` without resending, and Discord's `enforce_nonce` covers the window before the ledger write. On an ambiguous Discord outcome (timeout or 5xx) the bridge retries with the same nonce within 60 s.

### Error statuses

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Parser rejected the query or body |
| 401 | `unauthorized` | Missing or wrong bearer |
| 409 | `lease_held` | Another consumer holds the inbox lease |
| 502 | `discord_error` | Discord rejected the request after retries |
| 503 | `gateway_fatal` | The gateway closed with a fatal code (4004, 4010-4014) |

## Consequences

- Restarting the session needs only `hent session set`; the token and connection are untouched (IS-9).
- With the service down, inbound still reaches the session and replies still go out, without media (IS-8).
- The autonomous-participation feel now depends on the session following the skill, not on service code. That is the accepted risk of this decision.
- One bot token serves OpenClaw and the bridge during cutover; channels enter the bridge as `observe` and flip to `reply`/`ambient` one at a time so there are never double replies (IS-7).
