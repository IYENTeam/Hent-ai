# Hent-ai Identity Roadmap

Hent-ai lets an AI agent express its **hent** — its intent — as a visual emotion layer.

This document is the canonical source of truth for Hent-ai identity, profile, philosophy, and near-term roadmap decisions. It is written in the OpenWorden/Warden style: preserve the accepted direction, classify drift, and make the next review decision easy.

## Bottom line

Hent-ai is an **agent expression layer**:

> Natural agent voice → inferred emotion → matching character/profile image.

The agent writes naturally. Hent-ai reads the emotional signal from the final assistant response, resolves the active profile, selects the matching image, and attaches it. Agents should not hand-write `MEDIA:` directives or hard-code emotion image paths for Hent-ai.

## Canonical identity

### Product invariant

Hent-ai does not replace the agent's core identity, task policy, or safety rules. It adds a visual character/profile layer on top of the host agent.

Therefore:

- persona files should shape tone and emotional range;
- Hent-ai should infer emotion from response text and configured profile state;
- fallback behavior should be calm and non-disruptive;
- profile snippets must not silently override higher-priority system, developer, safety, or operator instructions.

### Canonical emotion vocabulary

The canonical emotion set is:

- `happy` — success, completion, celebration
- `neutral` — general informational responses
- `loyalty` — acknowledgment, greeting, attentive agreement
- `sorry` — mistakes, apologies, recovery
- `confused` — uncertainty, ambiguity, clarification
- `focused` — working, investigating, debugging

Any new emotion requires an explicit roadmap decision, asset expectations, classifier behavior, and runtime tests.

## Current accepted architecture

This section reflects the current code and docs as of this PR.

### Profile storage

Profiles are stored in SQLite at `<imageDir>/hentai.db`.

The accepted schema is implemented in `shared/db.ts` and currently includes:

- `profiles`
  - `id`
  - `name`
  - `character`
  - `soul_snippet`
  - `model`
  - `created_at`
  - `updated_at`
- `channel_profiles`
  - `channel_id`
  - `profile_id`
- `channel_settings`
  - `channel_id`
  - `enabled`
  - `asset_set_id`
- `profile_settings`
  - `profile_id`
  - `key`
  - `value`

Profile IDs are validated in `shared/profile.ts`: lowercase alphanumeric, hyphen, and underscore; max 64 chars; path traversal rejected.

### Profile image directories

Profile-specific images live under:

```text
<imageDir>/profiles/<profileId>/
```

`openclaw/profile-manager.ts` resolves profile image directories. If the profile directory exists, Hent-ai uses it. Otherwise it falls back to the root `imageDir`.

### Active profile resolution

For a Discord/OpenClaw channel, the active profile is resolved in this order:

1. `channel_profiles[channelId]`
2. plugin config `defaultProfile`
3. no active profile, falling back to the base image directory

Code references:

- `openclaw/profile-manager.ts` — `resolveActiveProfileId`, `resolveProfileImageDirForChannel`.
- `openclaw/dynamic-persona.ts` — matching lookup for profile `soulSnippet`.

### Dynamic persona injection

Profiles may define a `soulSnippet`. When present, OpenClaw can append it to the base prompt under this separator:

```text
--- Hent-ai Character ---
```

This is the accepted dynamic identity mechanism. The snippet refines character/tone; it is not a new owner of the agent's task policy.

Code reference:

- `openclaw/dynamic-persona.ts` — `buildDynamicPrompt`, `getSoulSnippetForChannel`, `appendPersonaToPrompt`.

### Runtime surfaces

Hent-ai currently has multiple runtime surfaces:

- OpenClaw plugin under `openclaw/`
- Cursor package under `cursor/`
- Hermes plugin under `hermes/`
- Shared profile/database code under `shared/`

OpenClaw is the primary runtime. Cursor and Hermes are portability surfaces and should not redefine Hent-ai identity or emotion vocabulary. If a platform intentionally differs, document that difference in `docs/classifier-customization.md` or the runtime README.

## Deferred or rejected directions

### Filesystem `characters/<id>/character.json`

Issue #70 originally proposed a filesystem character model:

```text
characters/<character-id>/character.json
characters/<character-id>/sets/<set-id>/...
```

That model is **not** the current accepted runtime architecture. Do not implement a second filesystem character system unless the owner explicitly revives it.

If filesystem import/export is needed later, treat it as an interchange format around the SQLite-backed profile model, not as a competing runtime source of truth.

### Per-user profile assignment

Per-user character/profile assignment is out of scope until explicitly accepted. The accepted mapping is channel/runtime-level profile assignment.

### Automatic profile switching

Automatic time-based, mood-based, mood-detection, or hidden-context profile switching is out of scope until explicitly accepted. Profile switching should be explicit through approved commands, scripts, onboarding flow, or host runtime configuration.

## Roadmap priorities

### P0 — Runtime correctness and installability

Before broad identity expansion, the primary runtime must remain reliable.

Priority surfaces:

- OpenClaw package installability and dependency topology.
- Discord attachment reliability and image sizing.
- Token/config handling that avoids implicit host-path reads.
- Tests for runtime contracts instead of only stubs.

### P1 — Classifier parity

Hent-ai should not feel like a different product on every platform.

Required direction:

- Define a shared classifier fixture/corpus covering the six canonical emotions.
- Include Korean, English, mixed-language, task-progress, apology, uncertainty, and noisy media-tag cases.
- Use the same fixture expectations across OpenClaw, Cursor, and Hermes where practical.
- Document accepted platform differences.
- Treat silent classifier drift as a roadmap risk.

### P2 — Character/profile system

Multi-character profiles are accepted as a roadmap direction using the current SQLite-backed profile model.

A profile may bundle:

- display name;
- character description;
- `soulSnippet` / personality metadata;
- image directory under `<imageDir>/profiles/<profileId>/`;
- channel/runtime override state.

Implementation gates:

- schema changes are documented before migration;
- migration from flat assets and manifest sets is reversible or backed up;
- channel-level override semantics are explicit;
- personality injection ownership stays bounded by host prompt policy;
- OpenClaw, Cursor, and Hermes behavior is intentionally aligned or documented as different.

### P3 — Better creation/onboarding UX

Agent-driven onboarding should stay conversational and context-aware.

Direction:

- infer obvious user intent from context and attachments;
- ask only for genuinely blocking decisions;
- preserve base character consistency across emotion variants;
- verify final files and profile database/manifest state before declaring setup complete.

## Warden review policy

Use OpenWorden-style Warden reviews when Hent-ai has multiple active issues, PRs, or agent tasks.

Classify work as:

- `aligned` — advances this roadmap with evidence;
- `needs-review` — plausible but missing evidence, scope control, or a decision;
- `drifting` — related but pulling toward another architecture or product boundary;
- `misaligned` — conflicts with this roadmap or silently creates a second source of truth;
- `blocked` — requires a human/product/architecture decision.

Recommended cancellation/pause triggers:

- runtime profile architecture that bypasses SQLite `profiles` / `channel_profiles`;
- filesystem `characters/<id>/character.json` revived as a second runtime SSOT;
- dynamic personality injection without host prompt-policy boundaries;
- platform-specific classifier rewrites without parity evidence;
- broad profile migrations without backup/diff/readback proof;
- asset, manifest, or profile DB mutations without diff/readback evidence;
- completion claims without tests, CI, or runtime evidence.

## Warden checklist for future PRs

Before merging or accepting identity/profile work, verify:

- [ ] The change preserves natural agent writing; Hent-ai still infers emotion and owns image attachment.
- [ ] The change cites this roadmap if it affects profile/personality identity.
- [ ] The change uses SQLite `profiles` / `channel_profiles` unless a new owner-approved decision replaces that architecture.
- [ ] The change does not revive filesystem `characters/<id>/character.json` as a second runtime SSOT.
- [ ] Classifier behavior changes include parity fixtures or documented intentional differences across OpenClaw, Cursor, and Hermes.
- [ ] Asset, manifest, or profile DB mutations include diff/readback evidence.
- [ ] Gateway restart, paid image generation, merge, credential changes, and destructive mutations remain owner-gated.

## Related trackers

- #70 — implementation/transition tracker for multi-character/profile work. It is not the sole SSOT if it conflicts with this roadmap.
- #46 — classifier parity gate.
- #47 — OpenClaw aliases/stubs runtime contract gate.
- #48 — coverage scope gate.
- #62 — package-manager/toolchain reproducibility gate.
- #43 — OpenClaw dependency topology/installability gate.

## Immediate next actions

1. Update #70 to reference this roadmap and retire conflicting `characters/<id>/character.json` runtime assumptions.
2. Resolve or explicitly defer OpenClaw installability/runtime contract issues before large profile work.
3. Create shared classifier parity fixtures for the canonical six emotions.
4. Keep Discord attachment reliability fixes narrow and land-ready with CI evidence.
