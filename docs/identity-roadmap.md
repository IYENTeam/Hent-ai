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

Shared exports include `EMOTIONS`, `DEFAULT_EMOTION`, `DEFAULT_EMOTION_MAP`, `EMOTION_RULES`, `EMOTION_PROMPTS`, `EMOTION_LABELS`, and `VALID_EMOTIONS`.

Any new emotion requires an explicit roadmap decision, asset expectations, classifier behavior, generation prompt behavior, and runtime tests.

## Architecture model

Hent-ai has a **server model** (the canonical Hent-ai service + thin OpenClaw adapter), a **compatibility server surface** (Hermes), and a **shared contract**.

> Note: a Cursor client surface previously existed but was removed (see commit `a3b4248`). There is no `cursor/` package in this repository. Do not document Cursor as a current runtime; if a client surface is revived, it must get an explicit roadmap decision.

### Server model — Hent-ai service is canonical for OpenClaw delivery

The Hent-ai service is the canonical server owner for live OpenClaw emotion/media decisions. OpenClaw is the host runtime that emits message hooks; the Hent-ai OpenClaw adapter must stay thin.

Service-owned responsibilities:

1. **Final-response verdict selection**
   - Classify or verify the final assistant response through the service verifier path.
   - Resolve the active channel/profile/asset policy.
   - Return Stage-1 media metadata for the host to attach.

2. **Profile, channel, and asset state**
   - Own profile/channel mappings, date-mode policy, asset manifests/storage, verifier cache, rate limits, and watcher state.
   - Treat SQLite-backed service state as the accepted runtime profile architecture unless a later owner-approved decision replaces it.

3. **OpenClaw adapter boundary**
   - Always register `reply_payload_sending` and forward final assistant reply context to `/v1/final-response/verdict`.
   - Attach service-returned media to the outgoing payload.
   - Optionally (opt-in via `hentAiService.preReplyMedia` / `hentAiService.watcher`) register `message_received` / `message_sent` to drive `/v1/pre-reply/media` and the watcher endpoints (`/v1/watcher/record-user`, `/v1/watcher/evaluate`, `/v1/watcher/commit-delivery`).
   - Keep text delivery owned by OpenClaw. Pre-reply media and watcher nudges go through OpenClaw's outbound channel adapter (`runtime.channel.outbound`), not direct Discord REST.
   - In standalone local service mode, Discord readback and watcher delivery may be owned by the Hent-ai service poller instead; this does not move Discord REST logic into the OpenClaw adapter.
   - Do not classify locally, scan manifests, read profile DBs, call `@hent-ai/generate`, call Discord REST directly, or implement delivery orchestration.

4. **Prompt/persona integration**
   - Profile snippets and prompt/persona injection remain bounded by host prompt policy.
   - Dynamic personality injection is not accepted unless the host policy boundary and service ownership are explicit.

Current server code references:

- `service/src/server.ts` — service HTTP endpoints, final-response verdict route, channel/profile policy integration.
- `service/src/verifier.ts` — final-response verifier provider contract.
- `service/src/db.ts` — service profile/channel/verifier state.
- `service/src/watcher-core.ts` and `service/src/watcher-adapter.ts` — watcher state and delivery gating.
- `openclaw/index.ts` — thin OpenClaw adapter registration and service delegation.
- `openclaw/README.md` — adapter setup and E2E verification contract.
- `docs/service-owned-gates.md` — current PR/release gate policy for this boundary.

Historical OpenClaw-local implementations that performed local classifier fallback, direct Discord REST fallback, manifest scanning, profile DB lookup, or image generation are superseded and non-normative. They are not a precedent for new PRs.

### Compatibility server surface — Hermes

Hermes is a compatibility adapter, not the canonical OpenClaw server.

Hermes responsibilities:

- register `transform_llm_output`;
- detect emotion with lightweight rules;
- resolve an asset directory via env/config;
- optionally use `HENT_AI_DEFAULT_PROFILE` as an asset subdirectory selector;
- append a Hermes `MEDIA:<path>` directive for Hermes Gateway delivery.

Hermes does **not** own:

- SQLite profile DB state;
- profile CRUD;
- channel profile mappings;
- OpenClaw prompt/persona injection;
- OpenClaw Discord PATCH/send behavior.

Hermes code references:

- `hermes/__init__.py` — rule detection, env-based profile asset resolution, `MEDIA:` directive construction.
- `hermes/plugin.yaml` — `transform_llm_output` hook and env vars.
- `hermes/README.md` — compatibility-surface behavior.
- `tests/hermes/test_hent_ai_plugin.py` — Hermes compatibility tests.

### Shared contract

`@hent-ai/shared` is the shared contract used by server/client surfaces.

Shared responsibilities:

- canonical emotion definitions and prompts (`shared/emotions.ts`);
- profile type definitions (`shared/profile.ts`);
- profile ID validation (`shared/profile.ts`);
- SQLite-backed profile/channel/settings DB utilities (`shared/db.ts`).

Current profile storage:

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
- resize/reference-limit inputs and optionally rephrase prompts when a caller provides a rephrase provider.

It must not define independent profile DB semantics.

## Current accepted profile architecture

The accepted runtime profile architecture is SQLite-backed service state plus profile image directories. OpenClaw does not read a local profile DB or `defaultProfile`; it receives the selected media from the Hent-ai service verdict/pre-reply APIs.

### Profile storage

Profiles are stored in SQLite through `ProfileDatabase` in the service runtime.

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

The service resolves active profile/media state from its SQLite-backed `channel_profiles` mapping and asset set records. The OpenClaw adapter must not duplicate that resolution logic or fall back to plugin-local profile configuration.

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

Do not describe OpenClaw and Hermes as equal identity/profile runtimes.

Correct wording:

- Hent-ai service + thin OpenClaw adapter: canonical server runtime path for OpenClaw delivery.
- Hermes: compatibility server adapter.
- Shared: contract layer.
- Generate: asset generation helper.

### Per-user profile assignment

Per-user character/profile assignment is out of scope until explicitly accepted. The accepted mapping is channel/runtime-level profile assignment.

### Automatic profile switching

Automatic time-based, mood-based, mood-detection, or hidden-context profile switching is out of scope until explicitly accepted. Profile switching should be explicit through approved commands, scripts, onboarding flow, or host runtime configuration.

## Roadmap priorities

### P0 — OpenClaw server correctness

Before broad identity expansion, the service-owned OpenClaw delivery path must remain reliable.

Priority surfaces:

- OpenClaw package installability and dependency topology.
- Discord attachment reliability and image sizing.
- OpenClaw payload attachment behavior through `reply_payload_sending`; direct Discord REST fallback must not be reintroduced.
- Token/config handling that avoids implicit host-path reads.
- Tests for runtime contracts instead of only stubs.
- Profile DB migrations with backup/readback evidence.

### P1 — Shared classifier and emotion parity

Hent-ai should not feel like a different product on every surface.

Required direction:

- Define a shared classifier fixture/corpus covering the six canonical emotions.
- Include Korean, English, mixed-language, task-progress, apology, uncertainty, greeting, and noisy media-tag cases.
- Use the same fixture expectations across the service/shared path and Hermes where practical.
- Document accepted server/client differences.
- Treat silent classifier drift as a roadmap risk.
- Do not reintroduce OpenClaw-local classifier rules. OpenClaw is service-owned; final-response emotion/verdict selection belongs in the Hent-ai service and shared contract layer.
- Treat surface-local classifier PRs as compatibility-only. If they duplicate the service/shared source of truth without parity fixtures or an explicit accepted difference, classify them as `misaligned` and close/request redesign.

### P2 — Profile system hardening

Multi-character profiles are accepted through the SQLite-backed profile model.

Implementation gates:

- schema changes documented before migration;
- migration from flat assets and manifest sets is reversible or backed up;
- channel-level override semantics are explicit;
- `soulSnippet` injection remains bounded by host prompt policy;
- The service-owned OpenClaw path is canonical; client/compat surfaces mirror only the parts they can honestly support.

### P3 — Compatibility UX

Compatibility surfaces should be honest about their scope.

Direction:

- Hermes should remain compatibility-focused unless it adopts shared profile DB state intentionally.
- Docs must not imply Hermes has OpenClaw profile orchestration.
- If a client surface (e.g. a future Cursor revival) is reintroduced, it needs an explicit roadmap decision and must stay a lightweight local rule/assets installer unless a separate client state model is approved.

### P4 — Better creation/onboarding UX

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
- docs that present OpenClaw and Hermes as symmetric profile runtimes;
- dynamic personality injection without host prompt-policy boundaries;
- platform-specific classifier rewrites without parity evidence;
- OpenClaw-local classifier or asset-selection fallback after the service-owned adapter migration;
- broad profile migrations without backup/diff/readback proof;
- asset, manifest, or profile DB mutations without diff/readback evidence;
- completion claims without tests, CI, or runtime evidence.

## Warden checklist for future PRs

Before merging or accepting identity/profile work, verify:

- [ ] The change preserves natural agent writing; Hent-ai still infers emotion and owns image delivery.
- [ ] The change cites this roadmap if it affects profile/personality identity.
- [ ] The change keeps service-owned final-response verdict/profile/channel policy as the canonical OpenClaw delivery path.
- [ ] The change uses SQLite `profiles` / `channel_profiles` unless a new owner-approved decision replaces that architecture.
- [ ] The change describes Hermes as a compatibility adapter unless it intentionally adopts shared DB state.
- [ ] The change does not revive filesystem `characters/<id>/character.json` as a second runtime SSOT.
- [ ] Classifier behavior changes include parity fixtures or documented server/client differences.
- [ ] OpenClaw adapter changes keep final-response emotion/verdict selection service-owned and do not add local classifier fallback.
- [ ] Asset, manifest, or profile DB mutations include diff/readback evidence.
- [ ] Gateway restart, paid image generation, merge, credential changes, and destructive mutations remain owner-gated.

## Related trackers

- #70 — implementation/transition tracker for multi-character/profile work. It is not the sole SSOT if it conflicts with this roadmap.
- #46 — classifier parity gate; after the service-owned adapter migration, this gate is satisfied through shared/service parity evidence, not OpenClaw-local rule duplication.
- `docs/service-owned-gates.md` — current hard gate policy for service-owned runtime boundaries.
- #47 — OpenClaw aliases/stubs runtime contract gate.
- #48 — coverage scope gate.
- #62 — package-manager/toolchain reproducibility gate.
- #43 — OpenClaw dependency topology/installability gate.
- #92 — Discord emotion attachment sizing/reliability hardening.

## Immediate next actions

1. Update #70 to reference this roadmap and retire conflicting `characters/<id>/character.json` runtime assumptions.
2. Resolve or explicitly defer OpenClaw installability/runtime contract issues before large profile work.
3. Create shared classifier parity fixtures for the canonical six emotions.
4. Keep Discord attachment reliability fixes narrow and land-ready with CI evidence.
