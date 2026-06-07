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

The gate runs the focused service verifier/worker regression tests and the full OpenClaw suite:

```bash
cd service && npx vitest run src/service.test.ts src/verifier.test.ts src/generation-worker.test.ts
cd openclaw && npx vitest run
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

## Deploy

Plugin is loaded by OpenClaw gateway from `plugins.load.paths` config.
After code changes: gateway restart required (`openclaw gateway restart` from main session, NOT from Discord embedded session).

Current plugin path: `/Users/iyen/projects/Hent-ai/openclaw`

## Common Operations

### Switch channel mode
```bash
cd ~/projects/Hent-ai
npx tsx openclaw/scripts/set_channel_mode.ts --channel <ID> --mode private|default
```

### Check asset manifest
```bash
cat assets/manifest.json | jq .
```

### Check channel overrides
```bash
cat assets/channel-overrides.json | jq .
```

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
