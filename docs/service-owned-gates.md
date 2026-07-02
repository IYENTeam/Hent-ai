# Service-owned Gate Policy

Hent-ai's live OpenClaw integration is service-owned. After the full service adapter migration, PR and release gates must protect that boundary instead of accepting surface-local fallback logic.

## Canonical ownership

- `service/` owns final-response verdict selection, verifier/cache state, channel policy, profile/channel mappings, asset lookup, and standalone Discord readback/chat participation when local polling is enabled.
- `openclaw/` is a thin OpenClaw adapter. It validates config, forwards final assistant reply context to the service, and attaches service-returned Stage-1 media to the outgoing payload.
- `shared/` is the contract layer for definitions and fixtures that must be reused across surfaces.
- `hermes/` is a compatibility adapter. It may keep lightweight rules only where Hermes cannot call the service yet, but those rules must be treated as compatibility mirrors, not a new source of truth.
- There is no current client surface. The former Cursor client was removed (commit `a3b4248`); if any client surface is revived it must not be documented as a canonical server/profile runtime.

## Hard rejects

Reject, close, or request redesign for changes that do any of the following without an explicit owner-approved architecture decision:

- reintroduce OpenClaw-local emotion classifiers, local asset selection, manifest scanning, profile DB reads, `@hent-ai/generate` calls, direct Discord REST calls, or delivery orchestration;
- add platform-specific classifier rewrites without shared fixtures or documented server/client differences;
- duplicate service-owned channel/profile policy in OpenClaw, Hermes, cron, or scripts;
- revive filesystem `characters/<id>/character.json` as runtime SSOT;
- treat successful stub tests as enough for runtime delivery, attachment, verifier, or Discord chat participation behavior;
- merge config/schema/plugin entry changes while Changeset Validation requires owner review and no owner approval/`owner-reviewed` label exists.

PR #99 is the reference case: it started as a useful audit repro, but after the service-owned OpenClaw adapter landed, the OpenClaw-local classifier part no longer fit the project direction. The correct action was to close rather than merge a second classifier path.

## Required evidence by change type

| Change type | Required evidence |
| --- | --- |
| OpenClaw adapter code | OpenClaw tests plus proof that `openclaw/` remains service-thin: no local classifier, no local asset/profile lookup, no direct Discord REST. |
| Service verdict/verifier changes | Service verifier/service tests and a request/response fixture for `/v1/final-response/verdict`. |
| Discord chat participation | Service poller tests plus live or fixture-backed readback evidence covering human intake, self-bot recording, reply timing, and loop prevention. |
| Hermes compatibility rules | Hermes tests plus parity evidence against `shared/` fixtures or an explicit documented difference. |
| Shared classifier/fixture changes | Cross-surface fixture updates where practical, including Korean, English, mixed-language, progress, apology, uncertainty, greeting, and noisy media-tag cases. |
| Asset/manifest/profile DB mutations | Diff/readback evidence; DB migrations require backup or reversible plan. |
| Live config/restart/deployment | Owner approval, active-work inventory, config diff/validation, one restart/reload attempt, health check, E2E/readback, and error-log grep. |

## Release-gate interpretation

Changeset Validation is an owner gate, not a nuisance check. If it fails because `openclaw/index.ts`, `openclaw.plugin.json`, or another runtime contract file changed, do not merge until one of these is true:

1. an approved owner review exists on the current head; or
2. the `owner-reviewed` label is added by the owner-approved process.

CI green does not override this gate. Contract changes can pass tests while still pulling the architecture toward the wrong ownership boundary.

## Reviewer checklist

Before accepting a PR touching Hent-ai runtime behavior:

- [ ] State which layer owns the behavior: `service`, `openclaw`, `shared`, `hermes`, or generate.
- [ ] Confirm the PR does not create a second source of truth for classifier, profile, channel policy, assets, or delivery.
- [ ] Confirm OpenClaw remains service-thin if `openclaw/` changed.
- [ ] Confirm Hermes changes are compatibility-only and tied to `shared/` parity evidence.
- [ ] Confirm broad regex/classifier changes include collision/first-match tests or documented accepted differences.
- [ ] Confirm runtime-facing claims have tests, CI, or E2E/readback evidence.
- [ ] Confirm owner-gated operations — merge, restart, deployment, credentials, destructive mutation, paid generation — have explicit owner approval.
