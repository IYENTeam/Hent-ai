# Hent-ai OpenClaw Adapter

Minimal Hent-ai service adapter for OpenClaw.

The adapter does not classify emotions, scan manifests, read profile databases, generate images, or call Discord directly. It validates service configuration, forwards OpenClaw final assistant reply context to the Hent-ai HTTP service, validates service responses, and returns OpenClaw Stage-1 media (`mediaUrl`, optional `mediaUrls`, `caption`, `sensitiveMedia`, `channelData`). In standalone local mode, the Hent-ai service owns Discord REST polling and chat participation.

## Configuration

Configure the `hentAiService` namespace in the plugin config:

```jsonc
{
  "plugins": {
    "entries": {
      "hent-ai-service-adapter": {
        "enabled": true,
        "config": {
          "hentAiService": {
            "url": "https://hent-ai.example.com",
            "token": "${HENT_AI_SERVICE_TOKEN}",
            "timeoutMs": 15000,
            "preReplyMedia": { "enabled": false }
          }
        }
      }
    }
  }
}
```

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `hentAiService.url` | `string` | yes | Base URL for the Hent-ai service. Non-localhost URLs must use HTTPS. `http://localhost` is allowed for local development. |
| `hentAiService.token` | `string` | yes | Bearer token for service requests. Literal values and `${ENV_VAR}` placeholders are supported. |
| `hentAiService.timeoutMs` | `number` | no | Request timeout. Defaults to `15000`. |
| `hentAiService.preReplyMedia` | `boolean` \| `{ enabled }` | no | Opt-in. When enabled, sends service-selected media as a separate message on inbound `message_received`. Defaults to **off**. |

Missing token, missing URL, invalid URL, or non-localhost HTTP disables the adapter at registration time and logs the disabled state.

> Note: `preReplyMedia` is read from the resolved `hentAiService` config by `openclaw/index.ts` and declared in `openclaw.plugin.json`'s `hentAiService` schema. Keep code and schema in sync when adding new `hentAiService` keys.

## Runtime Hooks

The final-response media path is always active. The pre-reply handler is registered by the adapter, but service calls and outbound delivery for pre-reply behavior run only when `preReplyMedia` is explicitly enabled.

| Hook | When | Condition | Service call |
| --- | --- | --- | --- |
| `reply_payload_sending` | Final assistant reply (`kind: "final"`) | always | `POST /v1/final-response/verdict` → attaches `verdict.media` to the payload |
| `message_received` | Inbound user message | `preReplyMedia` enabled | `POST /v1/pre-reply/media` → sends returned media as a separate message |

Block payloads and non-final `reply_payload_sending` kinds are ignored. Pre-reply media delivery uses OpenClaw's outbound channel adapter abstraction, never a direct Discord REST call. The legacy `pre_reply_media`, `message_sent_media`, and watcher/nudge hooks have been removed; do not depend on them for new setups.

Requests use bearer auth and JSON bodies containing the OpenClaw hook context. Service failures are non-blocking: timeout, network error, HTTP error, `null`, or malformed media leave the original payload unchanged and log a skip. OpenClaw continues text delivery.

### Final-response media

OpenClaw calls `reply_payload_sending` before final payload delivery. The adapter calls the service verdict endpoint and attaches `verdict.media` to the payload. OpenClaw owns the final text send and payload delivery mechanics; the Hent-ai service owns media selection, policy, profile/channel lookup, and verdict state.

Expected service response:

```json
{
  "verdict": {
    "media": {
      "url": "https://cdn.example/final.png"
    }
  },
  "diagnostics": []
}
```

If the service returns `dataBase64` instead of `url`, the adapter converts it to a data URL using `contentType` or `image/png`.

## Service-owned Decisions

The Hent-ai service owns:

- profile and channel mappings
- channel policy and date-mode policy
- asset manifests and storage
- emotion/verdict selection
- onboarding/generation jobs
- verifier/cache/rate-limit state
- short-term memory, long-term summary memory, and chat-reply policy for conversation rooms.

Service-side conversation knobs (defaults are conservative) can be controlled by environment variables:

- `HENT_AI_CONVERSATION_ENABLED` (default `false`)
- `HENT_AI_CONVERSATION_RAW_RETENTION_DAYS` (default `14`)
- `HENT_AI_CONVERSATION_MIN_DELAY_MS` (default `650`)
- `HENT_AI_CONVERSATION_MAX_DELAY_MS` (default `6500`)

Other conversation policy defaults (`maxChunks`, `maxChunkChars`, `cooldownMs`, etc.) are currently owned by service runtime config and can be adjusted in service deployment settings.

Standalone Discord polling is service-owned. Use `createHentAiServerWithPoller(...)` or deployment wiring that calls it, then configure:

- `HENT_AI_DISCORD_POLLER_TOKEN` (falls back to the generic `DISCORD_BOT_TOKEN`)
- `HENT_AI_DISCORD_POLLER_CHANNELS` (comma-separated Discord channel IDs)
- `HENT_AI_DISCORD_POLLER_BOT_USER_ID` (the bot user id; required for self-message evaluation)
- `HENT_AI_DISCORD_POLLER_INTERVAL_MS` (default `15000`)
- `HENT_AI_DISCORD_POLLER_EVALUATION_INTERVAL_MS` (default `60000`)
- `HENT_AI_DISCORD_POLLER_LIMIT` (default `50`, capped at Discord's `100`)
- `HENT_AI_DISCORD_POLLER_AUTO_START` (`false` disables automatic start)

The standalone service poller separates intake from chat reply checks:

- every new human Discord message is recorded immediately through the conversation intake path;
- every new self-bot Discord message is recorded immediately as an assistant turn, but it does not trigger a new reply by itself;
- reply checks run on `HENT_AI_DISCORD_POLLER_EVALUATION_INTERVAL_MS`, not once per incoming message;
- each reply check asks the service conversation decision provider whether the bot should answer naturally in the room;
- when the provider returns `speak` and policy gates allow it, the service sends the returned chunks to Discord and records those sent chunks as assistant turns.

Live Discord REST verification is opt-in because it needs a real bot token and channel:

```bash
cd service
HENT_AI_DISCORD_POLLER_TOKEN=... \
HENT_AI_DISCORD_POLLER_CHANNELS=123456789012345678 \
npm run verify:discord-rest
```

To verify real sends as well, set `HENT_AI_DISCORD_POLLER_LIVE_SEND_CONTENT` to the exact message body to post.

The OpenClaw adapter intentionally contains no fallback classifier, no local asset selection, no manifest scanning, no `shared/db` access, no `@hent-ai/generate` calls, no Discord token, and no direct `discord.com` REST calls.

Real image generation and LLM image/media calls are not invoked from OpenClaw tests; they are mocked or not reached in adapter contracts.

PR/release gate: any proposal that adds those responsibilities back into `openclaw/` is misaligned with the service-owned architecture unless an owner-approved architecture decision explicitly changes this boundary. CI success alone is not enough. See `../docs/service-owned-gates.md`.

## Local Verification

From `openclaw/`:

```bash
npx vitest run index.test.ts test/thinking-random.test.ts test/date-mode-e2e.test.ts test/channel-toggle.test.ts
```

Boundary regression checks for PRs touching `openclaw/`:

```bash
rg -n "detectEmotion|EMOTION_RULES|@hent-ai/generate|discord\.com/api|ProfileDatabase|manifest" openclaw/index.ts openclaw/*.ts --glob "!*.test.ts"
```

Expected result for runtime adapter files: no adapter-owned classifier, generate import, direct Discord REST call, profile DB read, or manifest scan. Test fixtures may mention legacy terms only when asserting they are absent or superseded.


## Current OpenClaw Setup Checklist

1. Load the adapter path:

   ```jsonc
   {
     "plugins": {
       "load": {
         "paths": ["/path/to/Hent-ai/openclaw"]
       }
     }
   }
   ```

2. Enable only `hent-ai-service-adapter` for Hent-ai in OpenClaw config. Remove any old `emotion-image` entry.
3. Set `hentAiService.url`, `hentAiService.token`, and optionally `hentAiService.timeoutMs`.
4. Configure channel mappings through the Hent-ai service, for example:

   ```bash
   curl -X PUT "$HENT_AI_SERVICE_URL/v1/channels/$DISCORD_CHANNEL_ID/mapping" \
     -H "Authorization: Bearer $HENT_AI_SERVICE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "profileId": "gothic-v1",
       "assetSetId": "gothic-v1",
       "mode": "normal",
       "enabled": true,
       "cronEnabled": false
     }'
   ```

5. For Discord threads, add a mapping for the thread id too. The adapter sends the active conversation id to the service.
6. Restart/reload OpenClaw after plugin code or load-path changes.
7. Validate with a real assistant final reply. Direct `message.send`, proactive sends, and fallback cron delivery can bypass `reply_payload_sending` and are not valid Hent-ai attachment E2E tests.
8. A valid E2E shows:
   - gateway log calling `/v1/final-response/verdict`
   - gateway log reporting returned media
   - Discord readback with non-empty `attachments`
