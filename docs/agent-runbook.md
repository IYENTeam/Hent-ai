# Hent-ai Agent Runbook

## Build

```bash
cd openclaw/
npm install        # if deps changed
```

No separate build step — TypeScript is loaded via tsx at runtime.

## Test

```bash
cd openclaw/
npx vitest run     # all tests, must pass before push
```

## Release Regression Gate

Before any release or main push, run the blocking local gate from the repository root:

```bash
node scripts/release-gate.mjs
```

Equivalent package script:

```bash
npm run release:check
```

The gate runs the service-owned boundary check, focused service verifier/poller/worker regression tests, adaptive ambient client/worker/runtime/delivery/archive/roster/wire/live regressions, shared emotion contract tests, generate manifest tests, Hermes compatibility tests, and the full OpenClaw suite:

```bash
node scripts/service-owned-boundary-check.mjs
cd service && npx vitest run src/service.test.ts src/verifier.test.ts src/discord-rest-poller.test.ts src/generation-worker.test.ts src/final-response-media-sanitizer.test.ts
cd service && npx vitest run src/adaptive-ambient-contracts.test.ts src/adaptive-ambient-provider.test.ts src/adaptive-ambient-runtime.test.ts src/adaptive-ambient-store.test.ts src/conversation-archive-scheduler.test.ts src/conversation-relationship-profile.test.ts src/discord-participant-client.test.ts src/discord-ambient-worker-core.test.ts src/discord-ambient-delivery.test.ts src/discord-ambient-worker.test.ts src/discord-ambient-worker.wire.test.ts src/discord-ambient-worker.live.test.ts src/adaptive-ambient-review-regressions.test.ts src/adaptive-ambient.redteam.test.ts src/conversation-ambient.test.ts src/discord-ambient-worker.redteam.test.ts
cd shared && npx vitest run
cd generate && npx vitest run src/sets.test.ts
python3 -m unittest discover -s tests/hermes
cd openclaw && npx vitest run
cd openclaw && npx tsc --noEmit
cd service && npx tsc --noEmit
cd generate && npx tsc --noEmit
```

Any failing command blocks the release. CI required-check enforcement is intentionally deferred; this gate is the local/manual release checklist for this slice.

## Remote Verifier Configuration

Production final-response verification uses an external verifier provider. Configure it through deployment environment variables or service config; do not put literal token values in docs or logs:

- `HENT_AI_VERIFIER_PROVIDER_KIND`
- `HENT_AI_VERIFIER_ENDPOINT`
- `HENT_AI_VERIFIER_TOKEN`
- `HENT_AI_VERIFIER_MODEL_OR_ROUTE`
- `HENT_AI_VERIFIER_TIMEOUT_MS`
- `HENT_AI_VERIFIER_EXTRA_HEADERS_JSON` for provider-specific headers
- `HENT_AI_VERIFIER_EXTRA_BODY_JSON` for provider-specific request body fields

Missing endpoint, token, model/route, or invalid timeout/header/body JSON fails verifier config creation. Per-request provider failures return no verdict rather than using deterministic fallback.

## Image Generation Job Path

The service exposes an async generation path. `POST /v1/assets/generate` creates a queued job; a worker/provider later processes that job with `runNextGenerationJob(db, provider, { assetRoot })`.

Minimum request shape:

```json
{
  "prompt": "image prompt",
  "assetSetId": "gothic-v1",
  "emotion": "sorry",
  "filename": "sorry.png"
}
```

Provider result shape for generated image persistence:

```json
{
  "dataBase64": "<base64 image bytes>",
  "contentType": "image/png",
  "metadata": {}
}
```

When `assetRoot` is supplied, the worker writes the image under `generated/<assetSetId>/<emotion>/<jobId>-<filename>`, upserts `storage_objects` and `assets`, strips inline base64 from the stored job result, and exposes the image through `/static/...`. Tests must keep providers mocked; do not trigger paid image generation in CI.

Persisted generated assets include provenance metadata on both `storage_objects` and `assets`: job id, content hash, content type, byte size, dimensions when known, source references, source (`hent-ai-generation-worker`), verification status, and hashes of request/provider metadata. The metadata intentionally avoids persisting raw prompts, conversation windows, or provider payloads with the long-lived storage object.

Generated asset writes are treated as immutable. A worker must fail rather than overwrite an existing generated storage key or asset id; active-set changes are pointer updates, not root-file copy operations.

For the community-cron workflow, `POST /v1/assets/generate` also accepts a cron selector request:

```json
{
  "communitySelector": {
    "conversationWindow": [
      { "authorId": "u1", "content": "hello", "createdAt": "2026-06-03T00:00:00Z" }
    ],
    "draftReply": "draft reply text",
    "channelId": "123",
    "profileId": "gothic-v1",
    "assetSetId": "gothic-v1"
  }
}
```

The service also exposes `GET /v1/channels/cron-enabled`, which returns the service-owned cron allowlist plus a revision token so OpenClaw can decide when to refresh its cached channel set.

## Discord ambient worker

The participant runs independently from the HTTP API:

```bash
cd service
npm run start:api
npm run start:discord-ambient-worker
```

The worker is fail-closed. Set `HENT_AI_DISCORD_PARTICIPANT_ENABLED=true`, `HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST` as comma-separated `guildId:channelId` Snowflake pairs, `HENT_AI_SERVICE_DB_PATH`, `HENT_AI_DISCORD_BOT_TOKEN`, `HENT_AI_CONVERSATION_PROVIDER_ENDPOINT`, `HENT_AI_CONVERSATION_PROVIDER_TOKEN`, and `HENT_AI_CONVERSATION_PROVIDER_MODEL`. Every allowlisted channel also needs an enabled service channel mapping. A selected profile must exist; its `soulSnippet` wins over `HENT_AI_CONVERSATION_PERSONA`, then the generic persona.

There is intentionally no Discord API-base environment setting. Production uses fixed Discord v10; only tests inject a loopback client base URL. The worker validates bot identity and guild/channel ownership only after acquiring a scope lease; with no acquired scope lease it remains archive-only standby and makes no Discord request. Its independent archive owner may still call the configured provider without a participant scope lease, but only for an exact startup-allowlisted Discord scope with a currently enabled DB mapping; it never calls the Discord API. That approved archive-only topology is not a blanket ban on all network. Archive compaction rechecks this boundary immediately before claim and provider dispatch, so raw legacy, disabled, or non-allowlisted scopes never reach the provider. Scope and claimed-work leases are 30 seconds with 10-second heartbeats; appraisal rechecks current mapping, abort, fence, and work claim after roster load and immediately before provider dispatch. Stop with `SIGINT` or `SIGTERM`; it aborts active work first, then cancels timers, stops archive/core ownership, waits the active boundary, releases matching leases, and closes SQLite. Roll back by stopping only the worker process or setting `HENT_AI_DISCORD_PARTICIPANT_ENABLED` to anything other than `true`; the API remains available and durable work is retained.

The conditional bot-token live-QA pair is guild `1483095221460799489` and channel `1498703634098294976`. It is QA-only and not production scope, default, or hard-coded configuration. Local loopback wire tests remain the sole proof of human ingress.

## Deploy

Plugin is loaded by OpenClaw gateway from `plugins.load.paths` config. Current production-style setup should load this repository's `openclaw/` adapter and enable `plugins.entries.hent-ai-service-adapter` with the `hentAiService` connection config.

After code changes or load-path changes: gateway restart/reload required (`openclaw gateway restart` from main session, NOT from Discord embedded session).

Example plugin path: `/Users/iyen/projects/Hent-ai/openclaw` or the checked-out repo path currently used by the gateway.

Do not use the old `plugins.entries.emotion-image` OpenClaw config entry for current service-adapter installs.

## Common Operations

### Set channel mapping

Channel/profile state is service-owned. Use the Hent-ai service API rather than local OpenClaw files:

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

For Discord threads, repeat the mapping for the thread id if replies are delivered in the thread.

### Validate attachment path

Use a real assistant final reply and then check Discord readback for non-empty `attachments`. Direct/proactive `message.send` and fallback cron delivery can bypass the OpenClaw `reply_payload_sending` hook and are not valid attachment E2E tests.

## Incident Patterns

### Cheer false positive (2026-05-19)
- Symptom: unwanted "화이팅!" + cheer.png sent to channel
- Cause: cheer intent classifier misclassified task request as emotional support
- Fix: tighten `buildCheerIntentPrompt` with negative examples
- Prevention: any prompt change → test with real frustration messages

### Manifest deletion (2026-05-18)
- Symptom: private asset set disappeared
- Cause: Python script deleted entire section instead of targeted edit
- Fix: manual manifest reconstruction
- Prevention: always `git diff` after any JSON manipulation script

### Path mismatch (2026-05-19)
- Symptom: private mode on but default images shown
- Cause: plugin imageDir pointed to old path, overrides saved to new path
- Fix: unified to ~/projects/Hent-ai as SSOT
- Prevention: after path changes, verify plugin's loaded imageDir in gateway logs

## Forbidden Actions

- `git push --force` on main
- Modifying production manifest.json without backup
- Running image generation in CI/test without mocks
- Merging PRs without test pass confirmation
