# Hent-ai Agent Runbook

Topology (see [ADR-0002](adr/ADR-0002-session-brain-bridge.md)): the always-on `hent bridge` owns the
Discord token and connection and pushes every inbound message into the bot session; the Claude Code or
Codex session running the `hent-mode` skill is the brain and replies with `hent send`; the Hent-ai
service is a token-free image picker and asset manager.

## Build

Node.js 22 is the baseline for `service/`, `shared/` and `generate/`; bun 1.3+ runs the session kit
(`kit/cli`, zero runtime dependencies). Use the checked-in lockfiles; do not refresh dependencies as
part of a release verification run.

```bash
node --version     # expected: v22.x
(cd service && npm ci) && (cd shared && npm ci) && (cd generate && npm ci)
(cd kit/cli && bun install --frozen-lockfile)
```

`scripts/release-gate.mjs` verifies the runtime. When invoked from another Node version it
re-executes a verified Homebrew Node 22 installation if present. On other layouts, point it to the
runtime explicitly: `HENT_AI_NODE22=/absolute/path/to/node node scripts/release-gate.mjs`.

## Test

```bash
(cd service && npx vitest run)
(cd kit/cli && bun test && bunx tsc --noEmit -p .)
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

The gate runs the service-owned boundary check (no Discord code or messenger token in `service/`,
no runtime dependency in `kit/cli`), the service, generate and shared suites, the session kit lanes,
static contracts, all TypeScript checks, and the external VisualAffectV2 corpus verifier:

```bash
node scripts/service-owned-boundary-check.mjs
(cd service && npx tsc --noEmit && npx vitest run)
(cd generate && npm run build && npx vitest run)
(cd shared && npx vitest run)
(cd kit/cli && bun install --frozen-lockfile && bunx tsc --noEmit -p . && bun test)
node scripts/verify-affect-assets.mjs "${HENT_AI_ASSET_ROOT:-$HOME/.hent-ai/assets}" "${HENT_AI_AFFECT_SET_ID:-gothic-affect-v3}"
```

The displayed commands are the expanded equivalent; use `node scripts/release-gate.mjs` from the
repository root so working directories and the Node.js 22 runtime are resolved consistently. Any
failure of this local gate blocks release.

List the nine portable CI lanes without executing them:

```bash
node scripts/release-gate.mjs --list-json
```

The trusted GitHub `Release` workflow invokes `node scripts/release-gate.mjs --ci` from the
hard-pinned `main` branch. That mode runs the portable package and static-contract lanes in a fresh
runner; it intentionally cannot substitute for the prior local gate's external corpus evidence.
The workflow's `dry_run` input defaults to true (a dry run validates without publishing), only its
publish job receives `contents: write`, and its immutable annotated tag handling safely resumes a
same-SHA release while rejecting a tag at a different SHA. It never deploys production. Pull-request
merges remain human-only.

See [Release Process](release-process.md) for the permanent `dev`, `release`, and `main` branch
flow, merge methods, RC and hotfix back-sync, dispatch steps, smoke checks, and rollback.

## Session kit configuration

Everything lives under `HENT_HOME` (default `~/.hent`, dirs 0700, files 0600). Values never go into
docs or logs.

| Item | Where | Read by |
| --- | --- | --- |
| Discord bot token | `~/.hent/discord.token` (0600; optional Keychain via `HENT_TOKEN_SOURCE=keychain`; `HENT_DISCORD_TOKEN` env for tests) | `hent bridge` only |
| Service URL | `HENT_URL` or `~/.hent/config.json` `serviceUrl` | `hent send`, `hent media` |
| Service API bearer | `~/.hent/service.token` (0600; `HENT_SERVICE_TOKEN` env overrides for tests) | `hent send`, `hent media`, `hent channels import` |
| Bridge local API secret | `~/.hent/bridge.secret` (created by the bridge) | every `hent` command that talks to the bridge |
| Channels | `~/.hent/channels.json` (`hent channels list/add/set/remove/import`) | `hent bridge` |
| Brain session | `~/.hent/session.json` (`hent session set`) | `hent bridge` push delivery |
| Global image switch | `HENT_ENABLED=0` (plain sends, no service call) | `hent send` |

The bridge runs as the LaunchAgent `ai.hent.bridge` (`hent bridge install` renders
`~/Library/LaunchAgents/ai.hent.bridge.plist`; it contains no token). Health: `GET
http://127.0.0.1:8789/v1/health`.

Brain session: start Claude Code or Codex with the `hent-mode` skill, then run
`hent session set --agent claude|codex --session-id <id> --cwd <dir> [--pane <pane>]`. Every inbound
message is pushed into that pane, or, when no pane is live, run as a headless resumed turn:

- Claude Code: `claude -p --resume <id> "<prompt>" --allowedTools="Bash(hent:*)"` (stdin `/dev/null`).
- Codex: `codex exec resume --skip-git-repo-check <id> "<prompt>"` (with network access for localhost).

## Affect asset routing and static media

The session rates each reply's emotional performance as a 24-dimension `ResponseAffectV2` vector and
passes it with `hent send --affect`. `hent send` asks `POST /v1/final-response/verdict` under one
2-second deadline (verdict plus media download) and sends plain text on any failure. A verdict
request without `responseAffect` is skipped with `missing_response_affect`; there is no verifier.
The router ranks every image in the channel's mapped set by normalized weighted Euclidean distance
to its stored `VisualAffectV2` vector. Candidates tied within `1e-12` are selected at random.

Both schemas use the exact 24-dimension `AffectSpaceV2` contract in `shared/affect.ts`. The importer
persists strict tags and ordered vectors. V2 mode activates only when every candidate in the mapped
set has a valid tag/vector pair whose values match. Incomplete or malformed sets fail closed to the
legacy path; legacy `SemanticAssetTagsV1` sets retain their old coarse-bucket cosine behavior.

Set `HENT_AI_ASSET_ROOT` to the external local store corresponding to imported storage keys; use
`~/.hent-ai/assets` for a new local deployment. The checkout's `assets/` is compatibility/reference
data, not the production image-pool store. `/static/<storage-key>` serves bytes only for a normalized
key already registered in `storage_objects`; traversal and unregistered files are rejected. Import
or migration is explicit: back up state, dry-run `importAssets`, inspect warnings and counts, perform
the import, then read back DB rows and `/static` bytes.

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

The service also exposes `GET /v1/channels/cron-enabled`, which returns the service-owned cron allowlist plus a revision token so a poller can decide when to refresh its cached channel set.

## Cutover (macmini)

Owner-gated: run only after the PR is merged and the owner says go. Each step is reversible.

0. Install bun (`curl -fsSL https://bun.sh/install | bash`). Build a release directory from the merged
   commit (`git clone` + checkout into `~/.hent-ai/releases/<sha>`); never pull into the checkout the
   old service still runs from. Verify the service plist `ProgramArguments` before editing it.
1. Write `~/.hent/discord.token` (0600) with the same bot token OpenClaw uses, and confirm the
   MESSAGE_CONTENT privileged intent is enabled in the developer portal. Write `~/.hent/service.token`.
2. `hent channels import --from-service <url>`: every channel lands as `observe` (journaled, never
   answered) and `dms:false`.
3. `hent bridge install`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hent.bridge.plist`;
   `/v1/health` must report `connected`.
4. Start the brain session with `hent-mode` and run `hent session set`.
5. Move channels in batches. The first batch is `1486627737568546979` alone; after its checks pass the
   rest go in one batch to limit gateway restarts. For each channel: remove it from OpenClaw's Discord
   channel allowlist in `~/.openclaw/openclaw.json` (back up first) and restart the gateway only when
   idle; if it is in the ambient worker allowlist (`HENT_AI_DISCORD_PARTICIPANT_ALLOWLIST`), remove it
   there and restart or stop that worker; then `hent channels set <channel> reply|ambient`. Verify one
   reply with an image from the session and no OpenClaw or ambient-worker reply in that channel. DMs
   stay with OpenClaw unless the owner moves them explicitly.
   5b. List `channel_settings` ids that are not Discord snowflakes (for example Slack); they lose media
   when the plugin is removed, so ask the owner before step 6.
6. After all channels: remove the `hent-ai-service-adapter` plugin entry and load path from OpenClaw,
   bootout and delete the `ai.hent-ai.ambient-worker` and `ai.hent-ai.codex-shim` plists (the worker
   plist holds the token), run `hent memory export --db ~/.hent-ai/data/hent-ai-service.db --out
   ~/.hent/memory`, and redeploy the service from the release directory without `HENT_AI_DISCORD_*`,
   `HENT_AI_CONVERSATION_*`, `HENT_AI_WATCH_CHANNELS` or `HENT_AI_VERIFIER_*`.

Rollback per channel: `hent channels set <channel> observe`, restore the OpenClaw allowlist entry, and
restore the ambient-worker allowlist entry if it had one.

## Deploy

The service runs from a release directory under `~/.hent-ai/releases/<sha>` via its LaunchAgent; the
bridge runs as `ai.hent.bridge`; the session kit is installed with `kit/install.sh` (links the skill
into `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` and `bun link`s `hent`).

## Common Operations

### Set channel mapping

Channel/profile state is service-owned. Use the Hent-ai service API rather than local files:

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
  `/static` bytes; the session kit has no runtime `imageDir`

## Forbidden Actions

- `git push --force` on main
- Modifying production manifest.json without backup
- Running image generation in CI/test without mocks
- Merging PRs without test pass confirmation
