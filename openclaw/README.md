# Hent-ai OpenClaw Adapter

Minimal Hent-ai service adapter for OpenClaw final assistant reply media.

The adapter does not classify emotions, scan manifests, read profile databases, generate images, or call Discord directly. It validates service configuration, forwards OpenClaw final assistant reply context to the Hent-ai HTTP service, validates the service response, and returns OpenClaw Stage-1 media (`mediaUrl`, optional `mediaUrls`, `caption`, `sensitiveMedia`, `channelData`). Text delivery remains owned by OpenClaw.

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
            "timeoutMs": 15000
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

Missing token, missing URL, invalid URL, or non-localhost HTTP disables the adapter at registration time and logs the disabled state.

## Runtime Hook

The adapter registers OpenClaw's current `reply_payload_sending` hook for final assistant replies only:

- `kind: "final"` → `POST /v1/final-response/verdict`

Block/pre-reply payloads are intentionally ignored. The legacy `pre_reply_media` and `message_sent_media` fallback hooks have been removed; do not depend on them for new setups.

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

The OpenClaw adapter intentionally contains no fallback classifier, no local asset selection, no manifest scanning, no `shared/db` access, no `@hent-ai/generate` calls, no Discord token, and no direct `discord.com` REST calls.

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
