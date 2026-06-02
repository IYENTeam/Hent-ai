# Hent-ai OpenClaw Adapter

Minimal Hent-ai service adapter for OpenClaw media lifecycle hooks.

The adapter does not classify emotions, scan manifests, read profile databases, generate images, or call Discord directly. It validates service configuration, forwards OpenClaw media hook context to the Hent-ai HTTP service, validates the service response, and returns OpenClaw Stage-1 media (`mediaUrl`, optional `mediaUrls`, `caption`, `sensitiveMedia`, `channelData`). Text delivery remains owned by OpenClaw.

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
            "timeoutMs": 5000
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
| `hentAiService.timeoutMs` | `number` | no | Request timeout. Defaults to `5000`. |

Missing token, missing URL, invalid URL, or non-localhost HTTP disables the adapter at registration time and logs the disabled state.

## Runtime Hooks

The adapter registers two OpenClaw Stage-1 media hooks:

- `pre_reply_media` → `POST /v1/pre-reply/media`
- `message_sent_media` → `POST /v1/final-response/verdict`

Requests use bearer auth and JSON bodies containing the OpenClaw hook context. Service failures are non-blocking: timeout, network error, HTTP error, `null`, or malformed media returns `{ "media": null, "diagnostics": [...] }` and logs a skip. OpenClaw continues text delivery.

### Pre-reply media

OpenClaw calls `pre_reply_media` before sending pre-reply text. The adapter calls the service and returns the selected media to OpenClaw. It never sends the pre-reply itself.

Expected service response:

```json
{
  "media": {
    "url": "https://cdn.example/pre.png",
    "caption": "optional caption",
    "sensitiveMedia": false,
    "channelData": {}
  },
  "diagnostics": []
}
```

### Final-response media

OpenClaw calls `message_sent_media` after final text delivery. The adapter calls the service verdict endpoint and returns `verdict.media`. OpenClaw owns append/edit/follow-up delivery.

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

## Local Verification

From `openclaw/`:

```bash
npx vitest run index.test.ts test/thinking-random.test.ts test/date-mode-e2e.test.ts test/channel-toggle.test.ts
```
