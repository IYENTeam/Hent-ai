# Service-owned PR and release gates

Hent-ai's runtime is split by [ADR-0002](adr/ADR-0002-session-brain-bridge.md): the `hent bridge`
daemon owns the Discord token and connection, a Codex session running `hent-mode` is the brain, and
the Hent-ai service is a token-free image picker. PR and release gates protect that split.

## Ownership

- `service/` owns final-response verdict selection (affect routing + verdict cache), channel/profile
  mappings, asset storage, generation jobs, and static media. It holds no messenger token and no
  Discord code.
- `kit/cli` owns the bridge (token, gateway, inbound journal, push delivery, send API) and the
  session commands (`hent send`, `skip`, `media`, `session`, `channels`, `memory`). It has zero runtime
  npm dependencies and fails open when the service is slow or down.
- `kit/skill/hent-mode` owns the session's conversation behavior (persona, when to speak, ambient
  participation, anti-repetition, affect rating, memory).
- `shared/` owns cross-package contracts (`emotions.ts`, `affect.ts`).

## Do not

- put a Discord token, Discord client, or `discord.com` call back into `service/`;
- add runtime dependencies to `kit/cli`;
- let any Hent-ai call block or delay a reply by more than its 2-second media deadline;
- treat successful stub tests as enough for runtime delivery, attachment, or push-delivery behavior.

## Required evidence by change type

| Change | Evidence |
| --- | --- |
| `service/` verdict or routing | service tests, a request/response fixture or contract version for `/v1/final-response/verdict`, and routed media bytes from a running service. |
| `kit/cli/src/bridge/*` | kit tests with the fake Discord server, plus a real-surface run (bridge + herdr pane session) showing delivery and confirmation. |
| `kit/cli` session commands | kit tests, including the service-down path (plain send within the deadline). |
| `kit/skill/hent-mode/*` | review against the cited sources in `references/conversation-sources.json`; the fixture test must pass. |
| assets / generation | `scripts/verify-affect-assets.mjs` on the external corpus; never trigger paid generation in tests. |

## Gates

The PR owner-review gate (`.github/workflows/pr-checks.yml`) requires owner approval when the bridge
or the kit package changes. The release gate is `node scripts/release-gate.mjs`; its `--ci` mode runs
the nine portable lanes. `node scripts/service-owned-boundary-check.mjs` blocks Discord surface in
`service/`, runtime dependencies in `kit/cli`, and the return of `openclaw/` or `hermes/`.

## PR checklist

- [ ] State which layer owns the behavior: `service`, `kit/cli`, `kit/skill`, `shared`, or `generate`.
- [ ] Confirm the service still holds no messenger token or Discord code.
- [ ] Confirm the kit still has no runtime dependencies and still fails open.
- [ ] Attach real-surface evidence for delivery changes.
