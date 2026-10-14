# Hent-ai Identity Roadmap

Hent-ai lets an AI agent express its **hent** — its intent — as a visual emotion layer.

This document is the canonical source of truth for Hent-ai identity, profile, and roadmap decisions. It is written in the OpenWorden/Warden style: preserve the accepted direction, classify drift, and make the next review decision easy.

## Bottom line

Hent-ai is an **agent expression layer**:

> Natural agent voice → inferred emotion → server/client delivery of the matching character/profile image.

The agent writes naturally. Hent-ai reads the emotional signal from the final assistant response, resolves the active profile where the host supports it, selects the matching image, and delivers it through the correct server or client surface. Agents should not hand-write Hent-ai media paths as their identity layer.

## Canonical identity

Hent-ai does not replace the agent's core identity, task policy, or safety rules. It adds a visual character/profile layer around the host agent.

Therefore:

- persona files should shape tone and emotional range;
- Hent-ai should infer emotion from response text plus configured profile state;
- fallback behavior should be calm and non-disruptive;
- profile snippets must not silently override higher-priority system, developer, safety, or operator instructions.

## Canonical emotion contract

The shared emotion contract lives in `@hent-ai/shared` (`shared/emotions.ts`).

The canonical emotion set is:

- `sorry` — apology, mistakes, recovery
- `happy` — success, completion, celebration
- `confused` — uncertainty, ambiguity, clarification
- `focused` — working, investigating, debugging
- `loyalty` — acknowledgment, greeting, attentive agreement
- `neutral` — general informational responses

Shared exports include `EMOTION_CONTRACT_VERSION`, `CANONICAL_EMOTIONS`, `EMOTIONS`, `DEFAULT_EMOTION`, `DEFAULT_EMOTION_MAP`, `EMOTION_RULES`, `EMOTION_PROMPTS`, `EMOTION_LABELS`, and `VALID_EMOTIONS`. `tests/fixtures/emotion-contract-v1.json` is the current cross-surface fixture.

Any new emotion requires an explicit roadmap decision, asset expectations, classifier behavior, generation prompt behavior, and runtime tests.

## Architecture model

Hent-ai has three runtime parts and a **shared contract** ([ADR-0002](adr/ADR-0002-session-brain-bridge.md)):

> Note: a Cursor client surface previously existed but was removed (see commit `a3b4248`). OpenClaw
> and Hermes adapters were removed by ADR-0002. Do not document them as current runtimes.

### Bridge - `hent bridge` owns the messenger connection

- Holds the Discord token (`~/.hent/discord.token`, 0600) and the gateway connection.
- Journals every inbound message and pushes each one into the brain session (tmux pane or headless
  resumed turn), retrying until the session replies or skips.
- Sends what the session asks (`/v1/send`, idempotent on nonce). Never calls the Hent-ai service.

### Brain - a Claude Code or Codex session with `hent-mode`

- Decides whether and what to answer (`kit/skill/hent-mode/references/conversation.md`) in the
  persona of `references/persona.md`.
- States each reply's `ResponseAffectV2` and sends with `hent send`, which attaches the image.

### Image picker - the Hent-ai HTTP service

- Owns profile/channel mappings, asset manifests/storage, the verdict cache, and generation jobs.
- Maps the session's affect to an image with the affect router; holds no messenger token and no
  Discord code.

Code references:

- `kit/cli/src/bridge/*` - bridge (token, gateway, journal, push delivery, local API).
- `kit/cli/src/commands.ts` - session commands.
- `service/src/final-response-use-case.ts` - affect-routed media verdict.
- `service/src/semantic-assets/router.ts` - nearest-neighbor affect router.
- `service/src/db.ts` - profile/channel state.

### Shared contract

`@hent-ai/shared` is the shared contract used by server/client surfaces.

Shared responsibilities:

- canonical emotion definitions and prompts (`shared/emotions.ts`);
- profile type definitions (`shared/profile.ts`);
- profile ID validation (`shared/profile.ts`);
- SQLite-backed profile/channel/settings DB utilities (`shared/db.ts`).

Legacy `ProfileDatabase` storage used by migration/generation tooling:

- DB file: `<imageDir>/hentai.db`
- Tables:
  - `profiles(id, name, character, soul_snippet, model, created_at, updated_at)`
  - `channel_profiles(channel_id, profile_id)`
  - `channel_settings(channel_id, enabled, asset_set_id)`
  - `profile_settings(profile_id, key, value)`

Profile IDs are lowercase alphanumeric slugs with hyphen/underscore allowed, max 64 chars, with path traversal and separators rejected.

### Generation contract

`@hent-ai/generate` is a generation package, not the profile SSOT.

Generation responsibilities:

- consume shared `EMOTIONS` and `EMOTION_PROMPTS`;
- generate a base image and one variant per emotion;
- support limited regeneration through shared emotion names;
- own its asset-set manifest helper under `generate/src/asset-manifest.ts`;
- resize/reference-limit inputs and optionally rephrase prompts when a caller provides a rephrase provider.
- for the semantic corpus, execute the deterministic 100-item/ten-batch plan with immutable
  candidates, receipts, content-hash reservations, item-level recovery, actual-pixel visual review,
  and injected LLM/vision tagging;
- stage manifest activation only after all accepted images and tags pass complete verification.

It must not define independent profile DB semantics.

### Affect asset contract

At generation time a vision-capable LLM assigns every accepted image a strict `VisualAffectV2`
vector from its actual pixels. At response time the brain session assigns its reply a
`ResponseAffectV2` vector in the same 24-dimensional `AffectSpaceV2`. The service considers every
image in the enabled channel's mapped V2 set, computes weighted Euclidean distance, and randomly
selects among exact-distance ties. A legacy coarse emotion remains optional compatibility metadata
and does not restrict V2 candidates.

V2 mode is all-or-nothing for a mapped set. Missing, malformed, incompatible, hash-stale, partial,
or tag/vector-mismatched metadata leaves the set on the safe legacy fallback path. The bridge and
the session never see tags or vectors and never rerank media.

Generated pools and their live manifest are external deployment data under `HENT_AI_ASSET_ROOT`,
not checked-in repository assets. A 100-image pool is activated only after independent pixel review,
pixel-only LLM/vision tags, hash uniqueness, external-manifest verification, DB import, channel
mapping readback, and live byte-level verification. Provenance records technical inputs and hashes
but does not assert copyright ownership, license scope, releases, or downstream rights.

## Current accepted profile architecture

The accepted runtime profile architecture is SQLite-backed service state plus profile image directories. The session kit does not read a local profile DB; it receives the selected media from the Hent-ai service verdict/pre-reply APIs.

### Profile storage

Profiles and channel mappings in the current service runtime are stored through `ServiceDatabase`, opened from the configured service DB path (`HENT_AI_SERVICE_DB_PATH`). `ProfileDatabase` remains only for generation migration tooling; it is not a service runtime profile SSOT.

The service runtime tables are `profiles`, `channel_mappings`, and `channel_settings`. `channel_mappings.profile_id` selects the profile and `channel_mappings.mode` selects the channel mode; `channel_settings.enabled` and its other settings hold service-owned channel policy. The legacy `channel_profiles` table belongs only to `ProfileDatabase` migration tooling.

A profile may include:

- `id`
- `name`
- `character`
- `soulSnippet`
- `model`
- timestamps

### Profile image directories

Profile-specific images live under the configured service image directory:

```text
<imageDir>/profiles/<profileId>/
```

The service resolves active profile/media state from its SQLite-backed `channel_mappings` and `channel_settings` records plus asset set records. The session kit must not duplicate that resolution logic.

### Dynamic persona injection

Profiles may define `soulSnippet`. The service-owned prompt/persona layer can append it to the base prompt under:

```text
--- Hent-ai Character ---
```

This is a bounded server-side character/tone layer. It is not a replacement for host instructions, safety policy, or user task policy.

## Deferred or rejected directions

### Filesystem `characters/<id>/character.json`

Issue #70 originally proposed a filesystem character model:

```text
characters/<character-id>/character.json
characters/<character-id>/sets/<set-id>/...
```

That model is **not** the current accepted runtime architecture. Do not implement a second filesystem character system unless the owner explicitly revives it.

If filesystem import/export is needed later, treat it as an interchange format around the SQLite-backed profile model, not as a competing runtime source of truth.

### Symmetric platform wording

Do not describe the bridge, the session, and the service as interchangeable runtimes. The bridge
owns the connection, the session owns behavior, and the service owns images and profiles.

### Per-user profile assignment

Per-user character/profile assignment is out of scope until explicitly accepted. The accepted mapping is channel/runtime-level profile assignment.

### Automatic profile switching

Automatic time-based, mood-based, mood-detection, or hidden-context profile switching is out of scope until explicitly accepted. Profile switching should be explicit through approved commands, scripts, onboarding flow, or host runtime configuration.

## Roadmap priorities

### P0 - Bridge and delivery correctness

- Every inbound message in a `reply`/`ambient` channel reaches the brain session once, in order,
  across session and bridge restarts; nothing is answered twice.
- A slow or down service never delays a reply beyond the 2-second media deadline.
- The service never regains a messenger token or Discord code.

### P1 - Conversation behavior parity

- `kit/skill/hent-mode/references/conversation.md` stays faithful to the cited sources in
  `conversation-sources.json`; changes to speaking rules are reviewed against them.

### P2 - Profile system hardening

- Keep SQLite-backed profiles and channel mappings in the service; add filesystem import/export only
  as an interchange format.

### P3 - More messengers

- Telegram or Slack would be new bridge backends behind the same local API; not started.

## Review checklist for future PRs

- [ ] The service still holds no messenger token or Discord code.
- [ ] The kit still has zero runtime dependencies and fails open.
- [ ] Delivery changes carry real-surface evidence (bridge + session).
- [ ] Affect routing stays service-owned; the session only states the affect.

## Related trackers

- ADR-0002 (`docs/adr/ADR-0002-session-brain-bridge.md`) - session brain with token-owning bridge.
- Plan `.omo/plans/session-owned-messenger.md` - execution and cutover.

## Immediate next actions

1. Run the owner-gated cutover (`docs/agent-runbook.md` "Cutover (macmini)"), first channel alone.
2. Retire the old ambient worker and OpenClaw plugin entry after every channel has moved.
