# Hent-ai OpenClaw Adapter

Minimal Hent-ai service adapter for OpenClaw.

The adapter does not classify emotions, scan manifests, read profile databases, generate images, or call Discord directly. It validates service configuration, forwards OpenClaw final assistant reply context plus optional group-chat turns to the Hent-ai HTTP service, validates service responses, and returns OpenClaw Stage-1 media (`mediaUrl`, optional `mediaUrls`, `caption`, `sensitiveMedia`, `channelData`). In OpenClaw-hosted mode, text delivery remains owned by OpenClaw and uses host send APIs; in standalone local mode, the Hent-ai service can own Discord REST polling and conversation delivery.

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
            "conversation": {
              "enabled": false,
              "watcherCompatibility": true
            }
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
| `hentAiService.watcher` | `boolean` \| `{ enabled }` | no | Opt-in. When enabled, registers the group-chat anti-fixation watcher (record/evaluate/commit). Defaults to **off**. |
| `hentAiService.conversation.enabled` | `boolean` | no | Forwards group-chat turns to the service when `true`. Defaults to `false`. |
| `hentAiService.conversation.watcherCompatibility` | `boolean` | no | Preserves compatibility payload fields with legacy watcher clients while using service-owned runtime behavior. Defaults to `true`. |

Missing token, missing URL, invalid URL, or non-localhost HTTP disables the adapter at registration time and logs the disabled state.

> Note: `preReplyMedia` and `watcher` are read from the resolved `hentAiService` config by `openclaw/index.ts` and declared in `openclaw.plugin.json`'s `hentAiService` schema. Keep code and schema in sync when adding new `hentAiService` keys.

## Runtime Hooks

The final-response media path is always active. The pre-reply and watcher handlers may be registered by the adapter, but service calls and outbound delivery for pre-reply/watcher behavior run only when the corresponding feature is explicitly enabled.

| Hook | When | Condition | Service call |
| --- | --- | --- | --- |
| `reply_payload_sending` | Final assistant reply (`kind: "final"`) | always | `POST /v1/final-response/verdict` → attaches `verdict.media` to the payload |
| `message_received` | Inbound user message | `preReplyMedia` enabled | `POST /v1/pre-reply/media` → sends returned media as a separate message |
| `message_received` | Inbound user message | `watcher` enabled | `POST /v1/watcher/record-user` (records conversation window) |
| `message_sent` | Outbound assistant message | `watcher` enabled | `POST /v1/watcher/evaluate`; on a `nudge` verdict, sends the nudge text and `POST /v1/watcher/commit-delivery` |

When conversation forwarding is enabled:

- `message_received` → `POST /v1/watcher/record-user`
- `message_sent` → `POST /v1/watcher/evaluate`, optional `POST /v1/watcher/commit-delivery`

Block payloads and non-final `reply_payload_sending` kinds are ignored. Pre-reply and watcher delivery use OpenClaw's outbound channel adapter abstraction, never a direct Discord REST call. The legacy `pre_reply_media` and `message_sent_media` fallback hooks have been removed; do not depend on them for new setups.

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

### Group-chat delivery

`conversation.enabled: true` allows service-owned conversation context to flow:

- user messages are sent from `message_received` as room turns (`scopeId`, `text`, `id`).
- bot messages are sent from `message_sent` for policy/gating and delivery decisions.
- if the service returns a `deliveryPlan`, the adapter sends each chunk through host `sendText` with the provided delays and commits delivery only after all required message IDs return.

Expected decision payload (partial):

```json
{
  "decision": "nudge",
  "deliveryPlan": {
    "planId": "watcher:scope-1",
    "scopeId": "channel:123:session:s1",
    "channelId": "123",
    "chunks": [
      {
        "chunkId": "watcher:scope-1:0",
        "text": "짧게 먼저 반응해도 좋고",
        "delayMs": 1200,
        "metadata": {
          "hentAiConversationChunk": true,
          "planId": "watcher:scope-1",
          "chunkIndex": 0,
          "chunkCount": 1
        }
      }
    ],
    "commit": {
      "planId": "watcher:scope-1",
      "cooldownKey": "channel:123:topic:repeat",
      "signalId": "signal-7",
      "requiredChunkIds": ["watcher:scope-1:0"]
    }
  }
}
```

## Service-owned Decisions

The Hent-ai service owns:

- profile and channel mappings
- channel policy and date-mode policy
- asset manifests and storage
- emotion/verdict selection
- onboarding/generation jobs
- verifier/cache/rate-limit state
- short-term memory, long-term summary memory, and speech delivery policy for conversation rooms.

Service-side conversation knobs (defaults are conservative) can be controlled by environment variables:

- `HENT_AI_CONVERSATION_ENABLED` (default `false`)
- `HENT_AI_CONVERSATION_RAW_RETENTION_DAYS` (default `14`)
- `HENT_AI_CONVERSATION_MIN_DELAY_MS` (default `650`)
- `HENT_AI_CONVERSATION_MAX_DELAY_MS` (default `6500`)

Other conversation policy defaults (`maxChunks`, `maxChunkChars`, `cooldownMs`, etc.) are currently owned by service runtime config and can be adjusted in service deployment settings.

Standalone Discord polling is service-owned. Use `createHentAiServerWithPoller(...)` or deployment wiring that calls it, then configure:

- `HENT_AI_DISCORD_POLLER_TOKEN` (falls back to `DISCORD_BOT_TOKEN`)
- `HENT_AI_DISCORD_POLLER_CHANNELS` (comma-separated Discord channel IDs)
- `HENT_AI_DISCORD_POLLER_BOT_USER_ID` (the bot user id; required for self-message evaluation)
- `HENT_AI_DISCORD_POLLER_INTERVAL_MS` (default `15000`)
- `HENT_AI_DISCORD_POLLER_LIMIT` (default `50`, capped at Discord's `100`)
- `HENT_AI_DISCORD_POLLER_AUTO_START` (`false` disables automatic start)

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
