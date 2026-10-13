# Hent-ai — AGENTS.md

Hent-ai attaches an emotion image to an AI agent's responses. A Claude Code or Codex session is the bot's brain; the always-on `hent bridge` daemon owns the Discord token and connection and pushes every inbound message into that session; the **Hent-ai HTTP service** is a token-free image picker and asset manager. See [`docs/adr/ADR-0002-session-brain-bridge.md`](docs/adr/ADR-0002-session-brain-bridge.md).

See [`docs/identity-roadmap.md`](docs/identity-roadmap.md) for canonical architecture/ownership decisions and [`docs/service-owned-gates.md`](docs/service-owned-gates.md) for the PR/release gate policy.

## Packages

| Path | Role |
| --- | --- |
| `service/` | Token-free image picker: final-response verdict (affect-routed media selection + cache), channel/profile mappings, asset storage, generation jobs, static media. No Discord code, no messenger token, no conversation engine. |
| `kit/` | Session kit. `kit/cli` (bun, zero runtime deps, bin `hent`): `hent bridge` (Discord token, gateway, inbound journal, push delivery into the session, send API), `hent send`/`skip`/`media`/`session`/`channels`/`memory`. `kit/skill/hent-mode` is the skill that makes a Claude Code/Codex session the bot's brain. |
| `shared/` | Contract layer: `shared/emotions.ts` (canonical 6-emotion set), `shared/affect.ts` (AffectSpaceV2), `shared/profile.ts`, `shared/db.ts`. |
| `generate/` | Asset generation helper (`hent-ai generate`/`profile`/`sets` CLI). Codex-backed image generation; consumes shared emotion definitions. |
| `assets/` | Image files and asset sets. |

## Rules

- TypeScript: follow existing code style, strict mode.
- All changes must pass the relevant package test suite (`npx vitest run` for service/generate/shared, `bun test` for kit/cli) before push.
- The service holds no messenger token and no Discord code (`scripts/service-owned-boundary-check.mjs` enforces it). Only `hent bridge` reads the Discord token (`~/.hent/discord.token`, 0600).
- The session kit has zero runtime npm dependencies (bun builtins only) and fails open: a slow or down service never adds more than about 2 s to a reply and never blocks it.
- Hent-ai must never block or slow the agent's main work; every feature stays switchable (`HENT_ENABLED=0`, per-channel `hent channels`).
- Image generation costs real money. Never trigger generation (Codex / `/v1/assets/generate` worker) in tests without mocking.
- Affect routing: the session states the reply's affect (`hent send --affect`); the service ranks every image in the channel's fully migrated VisualAffectV2 set. Partial/malformed metadata keeps the set on deterministic legacy fallback.

## Build & Test

```bash
# Node.js 22 baseline release gate: service/generate/shared regressions, session kit lanes,
# static contracts, boundary check, and the external affect corpus
node scripts/release-gate.mjs    # or: npm run release:check

# Per-package
cd service && npx vitest run
cd kit/cli && bun test && bunx tsc --noEmit -p .
```

See [`docs/agent-runbook.md`](docs/agent-runbook.md) for the bridge, the session setup, cutover, and the image-generation job path.

## Forbidden

- Never commit API keys, tokens, or secrets.
- Never auto-merge PRs. Create PR only; merge is human-only.
- Never modify `manifest.json` / asset sets without diff verification (2026-05-18 incident: script deleted an entire private set).
- Never push to main without all tests passing.
- Never put a messenger token or Discord client back into `service/` without an owner-approved architecture decision.

## Emotion contract

The canonical emotion set lives in `shared/emotions.ts`: `sorry`, `happy`, `confused`, `focused`, `loyalty`, `neutral`. Adding an emotion requires a roadmap decision (asset expectations, classifier behavior, generation prompt, tests). The session rates each reply's affect itself; the service maps that affect to an image.
