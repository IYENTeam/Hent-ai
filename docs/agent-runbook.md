# Hent-ai Agent Runbook

## Build

Node.js 22 is the reproducible baseline. Use the checked-in package lock for each package; do not
refresh dependencies as part of a release verification run.

```bash
node --version     # expected: v22.x
cd openclaw/
npm ci             # only when dependencies are not already installed
```

`scripts/release-gate.mjs` verifies the runtime. When invoked from another Node version it
re-executes a verified Homebrew Node 22 installation if present. On other layouts, point it to the
runtime explicitly: `HENT_AI_NODE22=/absolute/path/to/node node scripts/release-gate.mjs`.

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

The gate runs the service-owned boundary check, service and ambient regressions (including legacy
poller regression coverage, not a supported deployment path), shared contracts, generation
manifest checks, the external VisualAffectV2 corpus verifier, Hermes compatibility, the full OpenClaw
suite, all three TypeScript checks, and the isolated/restored local OpenClaw E2E:

```bash
node scripts/service-owned-boundary-check.mjs
(cd service && npx vitest run src/service.test.ts src/verifier.test.ts src/discord-rest-poller.test.ts src/generation-worker.test.ts src/final-response-media-sanitizer.test.ts)
(cd service && npx vitest run src/adaptive-ambient-contracts.test.ts src/adaptive-ambient-provider.test.ts src/adaptive-ambient-runtime.test.ts src/adaptive-ambient-store.test.ts src/conversation-archive-scheduler.test.ts src/conversation-relationship-profile.test.ts src/discord-participant-client.test.ts src/discord-ambient-worker-core.test.ts src/discord-ambient-delivery.test.ts src/discord-ambient-worker.test.ts src/discord-ambient-worker.wire.test.ts src/discord-ambient-worker.live.test.ts src/adaptive-ambient-review-regressions.test.ts src/adaptive-ambient.redteam.test.ts src/conversation-ambient.test.ts src/discord-ambient-worker.redteam.test.ts)
(cd shared && npx vitest run)
(cd generate && npx vitest run src/sets.test.ts)
node scripts/verify-affect-assets.mjs "${HENT_AI_ASSET_ROOT:-$HOME/.hent-ai/assets}" "${HENT_AI_AFFECT_SET_ID:-gothic-affect-v3}"
python3 -m unittest discover -s tests/hermes
(cd openclaw && npx vitest run)
(cd openclaw && npx tsc --noEmit)
(cd service && npx tsc --noEmit)
(cd generate && npx tsc --noEmit)
node scripts/e2e-hent-openclaw.mjs
```

The displayed commands are the expanded equivalent; use `node scripts/release-gate.mjs` from the
repository root so working directories and the Node.js 22 runtime are resolved consistently. Any
failure blocks release. The E2E has strict host
preconditions described below; if the host cannot safely satisfy them, the release remains blocked
rather than silently skipping the check.

List the nine portable CI lanes without executing them:

```bash
node scripts/release-gate.mjs --list-json
```

The trusted GitHub `Release` workflow invokes `node scripts/release-gate.mjs --ci` from the
hard-pinned `main` branch. That mode runs the portable package and static-contract lanes in a fresh
runner; it intentionally cannot substitute for the prior local gate's external corpus and
LaunchAgent restoration evidence. The workflow's `dry_run` input defaults to true, only its publish
job receives `contents: write`, and its immutable annotated tag handling safely resumes a same-SHA
release while rejecting a tag at a different SHA. It never deploys production or restarts the
gateway. Pull-request merges remain human-only.

See [Release Process](release-process.md) for the permanent `dev`, `release`, and `main` branch
flow, merge methods, RC and hotfix back-sync, dispatch steps, smoke checks, and rollback.

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

## Affect asset routing and static media

The primary path asks the same assistant generation to append a compact `ResponseAffectV2` transport
marker. The OpenClaw adapter removes that marker before delivery and sends the strictly parsed vector
with the visible final text. The service uses the remote final-response verifier only as a compatibility
fallback when the marker is absent or invalid. A coarse legacy emotion may also be present, but it does not filter a fully migrated V2 set.
The service-owned router ranks every image in the channel's mapped set by normalized weighted
Euclidean distance to its stored `VisualAffectV2` vector. Candidates tied within `1e-12` are selected
at random. OpenClaw transports the model-produced vector and attaches media; it does not calculate
scores or participate in ranking.

Both schemas use the exact 24-dimension `AffectSpaceV2` contract in `shared/affect.ts`. The importer
persists strict tags and ordered vectors. V2 mode activates only when every candidate in the mapped
set has a valid tag/vector pair whose values match. Incomplete or malformed sets fail closed to the
legacy path; legacy `SemanticAssetTagsV1` sets retain their old coarse-bucket cosine behavior.

Set `HENT_AI_ASSET_ROOT` to the external local store corresponding to imported storage keys; use
`~/.hent-ai/assets` for a new local deployment. The checkout's `assets/` is compatibility/reference
data, not the production image-pool store. `/static/<storage-key>` serves bytes only for a normalized
key already registered in `storage_objects`; traversal and unregistered files are rejected. Import
or migration is explicit: back up state, dry-run `importAssets`, inspect warnings and counts, perform
the import, then read back DB rows and `/static` bytes. Starting OpenClaw does not import or migrate
assets.

The `gothic-affect-v3` corpus is external deployment data generated and reviewed through the
workflow in `generate/README.md`. The release gate does not generate or call an LLM; it verifies
the external 100-image manifest, every pixel hash, complete actual-pixel tags, and activation state.

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

### Ambient tuning and calibration

Set per-channel overrides in `channel_settings.settings_json`; absent or invalid keys use these defaults:

| Key | Default |
| --- | --- |
| `ambientBudgetPerHour` | `20` |
| `ambientConfidenceFloor` | `0.7` |
| `ambientIdleDecayTauMs` | `7200000` (2h) |
| `ambientPressureTauMs` | `1800000` (30m) |
| `ambientPityEnabled` | `true` |

Run the deterministic domain calibration (no provider, network, or wait) after changing ambient decision behavior:

```bash
cd service
npx tsx scripts/replay-ambient-calibration.ts
```

The script exits nonzero when idle decay is not monotonic, pressure leaves `[0,1]`, or effective pity probability falls below its base probability.

## Real local OpenClaw E2E

```bash
node scripts/e2e-hent-openclaw.mjs
```

This command is destructive to availability even though it is designed to be non-destructive to
state: it briefly stops the real local OpenClaw LaunchAgent and binds its usual port. Run it only on
macOS when all of these preconditions are true:

- Node.js 22 and the global OpenClaw entry
  `/opt/homebrew/lib/node_modules/openclaw/dist/index.js` are installed;
- the healthy LaunchAgent `ai.openclaw.gateway` is listening on `127.0.0.1:18789`;
- that gateway loads this checkout's `openclaw/index.ts`;
- no agent, delivery, automation, or external channel work is active; and
- the operator can immediately inspect/recover the gateway if restoration fails.

Do not adapt this harness to real Discord/Slack/etc. credentials or an external LLM endpoint. Do
not run it casually on a remote, shared, production, non-LaunchAgent, or differently managed
gateway. The disposable child and same-port phases use temporary `HOME`, `OPENCLAW_HOME`,
`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, workspace, DB, and assets. The model provider, Hent
service, semantic static files, inbound channel, and outbound adapter are all loopback. The same-port
config has no MCP key, scrubs credential-like environment variables, disables hooks/ambient
features, and fails if logs reveal MCP or a non-loopback HTTP URL.

The first phase proves the full hook flow with pre-reply, final semantic media, watcher chunks, and
commit using exact-byte hashes. The second phase boots out the existing LaunchAgent, runs a
final-only smoke on port 18789, and proves the stopped original state inventory was unchanged. In a
`finally` block the harness stops the disposable foreground gateway, restores the original
LaunchAgent, waits for connectivity, and compares config bytes/mode, plist hash, state inventory,
and loaded adapter source. Any failure, including restore/readback failure, blocks release. Before
doing anything else, verify `openclaw gateway status` and restore the original LaunchAgent manually
if necessary.

## Deploy

Plugin is loaded by OpenClaw gateway from `plugins.load.paths` config. Current production-style setup should load this repository's `openclaw/` adapter and enable `plugins.entries.hent-ai-service-adapter` with the `hentAiService` connection config.

After code changes or load-path changes: gateway restart/reload required (`openclaw gateway restart` from main session, NOT from Discord embedded session).

Example plugin path: `<repo>/openclaw`, resolved to the checked-out repository path currently used by the gateway.

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

Use the loopback E2E above for the release proof. A production-channel assistant reply plus Discord
attachment readback is an optional deployment check only with explicit owner approval and confirmed
external-send safety; it is not a substitute for the isolated exact-byte test. Direct/proactive
`message.send` and fallback cron delivery can bypass `reply_payload_sending` and are not valid
final-response attachment E2E tests.

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
- Fix: migrated the mapping/assets into service-owned storage
- Prevention: verify the service channel mapping, storage key, `HENT_AI_ASSET_ROOT`, and returned
  `/static` bytes; the OpenClaw adapter has no runtime `imageDir`

## Forbidden Actions

- `git push --force` on main
- Modifying production manifest.json without backup
- Running image generation in CI/test without mocks
- Merging PRs without test pass confirmation
