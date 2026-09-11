# Hent-ai OpenClaw Adapter

Minimal Hent-ai service adapter for OpenClaw.

The adapter does not classify emotions, scan manifests, read profile databases, generate images,
or call Discord directly. It validates service configuration, forwards OpenClaw final assistant
reply context plus optional group-chat turns to the Hent-ai HTTP service, validates service
responses, and returns OpenClaw Stage-1 media (`mediaUrl`, optional `mediaUrls`, `caption`,
`sensitiveMedia`, `channelData`). Text and media delivery remain owned by OpenClaw host APIs. The
service owns policy, semantic asset routing, and static media; the deprecated
`server-with-poller` composition is not a supported OpenClaw happy path.

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
| `hentAiService.conversation.enabled` | `boolean` | no | Forwards group-chat turns to the service when `true`. Defaults to `false`. |
| `hentAiService.conversation.watcherCompatibility` | `boolean` | no | Enables internal anti-fixation steering while conversation forwarding is enabled. The adapter injects guidance into the agent prompt and never sends it as an outbound message. Defaults to `true`. |

Missing token, missing URL, invalid URL, or non-localhost HTTP disables the adapter at registration time and logs the disabled state.

> Note: The former standalone `watcher` toggle is deprecated and ignored. Anti-fixation steering runs only when `conversation.enabled` is `true` and `conversation.watcherCompatibility` is not `false`.

## Runtime Hooks

The final-response media path is always active. Pre-reply media is independently opt-in. Conversation tracking and anti-fixation steering run only as part of the conversation module.

| Hook | When | Condition | Service call |
| --- | --- | --- | --- |
| `reply_payload_sending` | Final assistant reply (`kind: "final"`) | always | `POST /v1/final-response/verdict` → attaches `verdict.media` to the payload |
| `message_received` | Inbound user message | `preReplyMedia` enabled | `POST /v1/pre-reply/media` → sends returned media as a separate message |
| `message_received` | Inbound user message | conversation enabled | `POST /v1/watcher/record-user`; queues the scope for prompt-time steering when compatibility is enabled |
| `before_prompt_build` | Before the next agent generation | a steering scope is pending | `POST /v1/watcher/steer`; appends returned guidance as one-shot system context |
| `message_sent` | Outbound assistant message | conversation enabled | `POST /v1/watcher/record-assistant` |

When conversation forwarding and anti-fixation compatibility are enabled:

- `message_received` records the user turn and queues its conversation scope for the next prompt.
- `before_prompt_build` asks the service whether that prompt needs a steer and consumes the result once as private system context.
- `message_sent` records the actual assistant turn exactly once.

The user turn is never evaluated as an assistant turn. Anti-fixation text never goes through OpenClaw's outbound adapter. Block payloads and non-final `reply_payload_sending` kinds are ignored. The legacy `pre_reply_media` and `message_sent_media` fallback hooks have been removed; do not depend on them for new setups.

Requests use bearer auth and JSON bodies containing the OpenClaw hook context. Service failures are non-blocking: timeout, network error, HTTP error, `null`, or malformed media leave the original payload unchanged and log a skip. OpenClaw continues text delivery.

### Final-response media

OpenClaw calls `reply_payload_sending` before final payload delivery. The adapter calls the service verdict endpoint and attaches `verdict.media` to the payload. OpenClaw owns the final text send and payload delivery mechanics; the Hent-ai service owns media selection, policy, profile/channel lookup, and verdict state.

Ordinary Hent-ai emotion assets are returned with `sensitiveMedia: false` so durable final delivery can attach them. Assets explicitly classified as sensitive must retain `sensitiveMedia: true`; compatible OpenClaw hosts reject those attachments while preserving the reply text.

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

### Internal anti-fixation steering

`conversation.enabled: true` lets the service track user and assistant turns. When recent assistant turns repeat the same frame, `/v1/watcher/steer` returns private guidance for the next generation. The adapter stores only the pending conversation scope by OpenClaw session, evaluates it in `before_prompt_build`, and consumes it once.

The guidance explicitly tells the agent to change approach and not expose the detector. The adapter never returns it from `message_sending`, passes it to an outbound text API, or commits it as a conversation delivery plan.

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

## Real local OpenClaw E2E

From the repository root, the release E2E is:

```bash
node scripts/e2e-hent-openclaw.mjs
```

This is not a casual smoke command. It is intended for the documented local macOS topology with
the global OpenClaw entry at `/opt/homebrew/lib/node_modules/openclaw/dist/index.js`, a healthy
LaunchAgent gateway on `127.0.0.1:18789`, and this checkout already loaded as
`hent-ai-service-adapter`. Do not run it while the gateway has active external work or if those
preconditions are absent.

The harness first proves the complete flow in a disposable child gateway: disposable `HOME`,
state, workspace, config, SQLite DB, semantic assets, deterministic local provider/verifier, and
loopback outbound adapter. It checks final text, exact static media bytes, pre-reply media, private
anti-fixation prompt injection, and zero watcher text deliveries. It then temporarily boots out the
existing LaunchAgent and occupies the same port with another disposable configuration. That phase disables ambient/pre-reply/conversation
features and permits only the loopback QA channel, local provider, local Hent service, and the two
checked-out plugins. Credentials are scrubbed, no MCP is configured, and logs must contain no MCP
or non-loopback HTTP URL.

The `finally` path stops the foreground gateway, bootstraps the original LaunchAgent, waits for a
healthy connectivity probe, and proves the original config bytes/mode, LaunchAgent plist hash,
state inventory, and checkout adapter source are unchanged/restored. A failure in restoration is
a failed E2E and requires operator attention before any further gateway work.


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
