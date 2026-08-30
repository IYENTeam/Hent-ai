# Service-owned Gate Policy

Hent-ai's live OpenClaw integration is service-owned. After the full service adapter migration, PR and release gates must protect that boundary instead of accepting surface-local fallback logic.

## Canonical ownership

- `service/` owns final-response verdict selection, verifier/cache state, channel policy,
  profile/channel mappings, semantic asset lookup/ranking, watcher state, storage, and static media.
- `openclaw/` is a thin OpenClaw adapter. It validates config, forwards final assistant reply context to the service, and attaches service-returned Stage-1 media to the outgoing payload.
- `shared/` is the contract layer for definitions and fixtures that must be reused across surfaces.
- `hermes/` is a compatibility adapter. It may keep lightweight rules only where Hermes cannot call the service yet, but those rules must be treated as compatibility mirrors, not a new source of truth.
- There is no current client surface. The former Cursor client was removed (commit `a3b4248`); if any client surface is revived it must not be documented as a canonical server/profile runtime.

The supported topology is the API-only service plus the thin OpenClaw adapter. The former
`server-with-poller` composition remains covered only as legacy regression code and is not a
supported deployment or fallback happy path. The optional ambient participant, when enabled, is a
separate service worker as defined by ADR-0001.

## Discord ambient worker gate

The participant worker is service-owned and has a separate process boundary. Review any worker change for: API-only `main.ts` with no participant import/start; startup-only strict guild/channel allowlist intersected with enabled service mappings; no environment Discord API base URL; bot token and provider secrets absent from logs; scoped 30-second fenced leases and claimed-work leases with 10-second heartbeats; mapping/abort/fence rechecks after roster load and immediately before provider dispatch; zero Discord identity/verification/poll/typing/send calls when no scope lease is acquired; archive claim and provider dispatch dynamically reauthorized against the exact Discord scope plus current mapping; provider calls outside transactions; durable queue/nonce receipts; and abort-first SIGINT/SIGTERM timer-boundary-fence-DB shutdown. The archive owner has a separate lease and may call the configured provider without a participant scope lease only for exact startup-allowlisted, currently DB-enabled Discord scopes; it makes zero Discord API calls. This approved archive-only topology is not "zero all network." Require focused entrypoint tests that prove invalid configuration opens no Discord network path, scheduler-before-poll order, heartbeat loss, abort-first shutdown, and multi-scope ownership/release.

The pinned bot-token live-QA pair is never a production scope. Local loopback wire tests, not live bot activity, prove human Discord ingress.

## Hard rejects

Reject, close, or request redesign for changes that do any of the following without an explicit owner-approved architecture decision:

- reintroduce OpenClaw-local emotion classifiers, local asset selection, manifest scanning, profile DB reads, `@hent-ai/generate` calls, direct Discord REST calls, or delivery orchestration;
- add platform-specific classifier rewrites without shared fixtures or documented server/client differences;
- duplicate service-owned channel/profile policy in OpenClaw, Hermes, cron, or scripts;
- revive filesystem `characters/<id>/character.json` as runtime SSOT;
- treat successful stub tests as enough for runtime delivery, attachment, verifier, or watcher behavior;
- merge config/schema/plugin entry changes while Changeset Validation requires owner review and no owner approval/`owner-reviewed` label exists.

PR #99 is the reference case: it started as a useful audit repro, but after the service-owned OpenClaw adapter landed, the OpenClaw-local classifier part no longer fit the project direction. The correct action was to close rather than merge a second classifier path.

## Required evidence by change type

| Change type | Required evidence |
| --- | --- |
| OpenClaw adapter code | OpenClaw tests plus proof that `openclaw/` remains service-thin: no local classifier, no local asset/profile lookup, no direct Discord REST. |
| Service verdict/verifier changes | Service verifier/service tests, finite verifier-cache expiry evidence, and a request/response fixture or contract version for `/v1/final-response/verdict`. |
| Affect routing/tags/vector changes | Strict `VisualAffectV2`/`ResponseAffectV2` parsing, shared dimension order and weights, full mapped-set nearest-distance evidence, random equal-distance tie tests, and all-or-nothing legacy fallback tests. |
| Watcher behavior | Watcher core/service tests covering state lifetime, dedup/cooldown, self-nudge prevention, and scope/thread handling. |
| Hermes compatibility rules | Hermes tests plus parity evidence against `shared/` fixtures or an explicit documented difference. |
| Shared classifier/fixture changes | Cross-surface fixture updates where practical, including Korean, English, mixed-language, progress, apology, uncertainty, greeting, and noisy media-tag cases. `tests/fixtures/emotion-contract-v1.json` is the current fixture. |
| Asset/manifest/profile DB mutations | Diff/readback evidence; DB migrations require backup or reversible plan. |
| Affect corpus generation/activation | One request per planned image, immutable candidate/review evidence, hash reservations and crash recovery, pixel-only LLM/vision tags with SHA provenance, 100 unique final hashes, external-store verification, DB/channel readback, and live byte verification. Provenance must not be presented as a rights grant. |
| Live config/restart/deployment | Owner approval, active-work inventory, config diff/validation, one restart/reload attempt, health check, E2E/readback, and error-log grep. |

## Release-gate interpretation

Changeset Validation is an owner gate, not a nuisance check. If it fails because `openclaw/index.ts`, `openclaw.plugin.json`, or another runtime contract file changed, do not merge until one of these is true:

1. an approved owner review exists on the current head; or
2. the `owner-reviewed` label is added by the owner-approved process.

CI green does not override this gate. Contract changes can pass tests while still pulling the architecture toward the wrong ownership boundary.

`node scripts/release-gate.mjs` is the Node.js 22 local release gate. In addition to the boundary,
package, and type checks, it runs the complete 100-image semantic verifier and the disposable-child
plus restored-same-port real local OpenClaw E2E. The E2E may not be skipped when making a release
claim. It must run only under the documented safety preconditions: no active external work,
disposable HOME/state/config, loopback provider/channel/service, no MCP or external URL, and
verified restoration of the original LaunchAgent/config/state. A host that cannot safely meet those
conditions is release-blocked.

`node scripts/service-owned-boundary-check.mjs` remains part of that gate. It blocks an OpenClaw
adapter package that grows beyond the thin runtime surface, an OpenClaw `tsconfig` that re-includes
legacy local runtime modules, or a generate package that imports OpenClaw asset-manifest internals.

The repository PR template includes architecture-boundary checkboxes. Do not mark them complete unless the release gate and any needed owner-approved architecture decision are present.

## Reviewer checklist

Before accepting a PR touching Hent-ai runtime behavior:

- [ ] State which layer owns the behavior: `service`, `openclaw`, `shared`, `hermes`, or generate.
- [ ] Confirm the PR does not create a second source of truth for classifier, profile, channel policy, assets, or delivery.
- [ ] Confirm OpenClaw remains service-thin if `openclaw/` changed.
- [ ] Confirm Hermes changes are compatibility-only and tied to `shared/` parity evidence.
- [ ] Confirm broad regex/classifier changes include collision/first-match tests or documented accepted differences.
- [ ] Confirm runtime-facing claims have tests, CI, or E2E/readback evidence.
- [ ] Confirm owner-gated operations — merge, restart, deployment, credentials, destructive mutation, paid generation — have explicit owner approval.
