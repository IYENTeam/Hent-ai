# Hent-ai — AGENTS.md

Hent-ai attaches an emotion image to an AI agent's responses. The canonical runtime is the **Hent-ai HTTP service**; OpenClaw runs a thin adapter that delegates to it. Hermes is a compatibility adapter.

See [`docs/identity-roadmap.md`](docs/identity-roadmap.md) for canonical architecture/ownership decisions and [`docs/service-owned-gates.md`](docs/service-owned-gates.md) for the PR/release gate policy.

## Packages

| Path | Role |
| --- | --- |
| `service/` | Canonical runtime: final-response verdict selection, verifier + cache, channel/profile mappings, semantic asset routing, asset storage, generation jobs, watcher state, static media. |
| `openclaw/` | Thin OpenClaw adapter. Forwards hooks to the service; owns no classifier/profile/asset logic. Entry: `openclaw/index.ts`. |
| `shared/` | Contract layer: `shared/emotions.ts` (canonical 6-emotion set + prompts/labels/rules), `shared/profile.ts`, `shared/db.ts`. |
| `generate/` | Asset generation helper (`hent-ai generate`/`profile`/`sets` CLI). Codex-backed image generation; consumes shared emotion definitions. |
| `hermes/` | Python Hermes compatibility plugin (`transform_llm_output`, rule-based detection, `MEDIA:` directive). |
| `assets/` | Image files and asset sets. |

> Legacy OpenClaw modules (`profile-manager.ts`, `dynamic-persona.ts`, `channel-filter.ts`, `date-mode.ts`, `migration.ts`) are **not** wired into the service adapter entry. Do not treat them as the runtime path.

## Rules

- TypeScript: follow existing code style, strict mode.
- All changes must pass the relevant package test suite (`npx vitest run`) before push.
- Plugin is loaded by OpenClaw at runtime — changes require gateway restart or hot-reload.
- The OpenClaw adapter must stay service-thin: no local classifier, no manifest scan, no profile DB read, no `@hent-ai/generate` call, no direct `discord.com` REST. Pre-reply/watcher delivery uses OpenClaw's outbound channel adapter, not direct Discord.
- Image generation costs real money. Never trigger generation (Codex / `/v1/assets/generate` worker) in tests without mocking.
- Semantic routing is second-stage only: the service verifier chooses one canonical emotion, then
  the service ranks that emotion's fully tagged candidates. Partial/malformed semantic metadata
  must keep the whole candidate set on deterministic legacy fallback.
- `scripts/e2e-hent-openclaw.mjs` temporarily replaces the process listening on the real local
  gateway port. Run it only on the documented macOS/LaunchAgent topology after checking that the
  gateway is healthy and no external work is active. Its disposable config must contain no MCP or
  external channel/provider endpoint, and the original config/state/LaunchAgent must be restored.

## Build & Test

```bash
# Node.js 22 baseline: service/generate/OpenClaw regressions, complete semantic corpus,
# typechecks, and the isolated/restored real-local-OpenClaw E2E
node scripts/release-gate.mjs    # or: npm run release:check

# Per-package
cd openclaw && npx vitest run
cd service && npx vitest run
```

See [`docs/agent-runbook.md`](docs/agent-runbook.md) for deploy, verifier config, and the image-generation job path.

## Forbidden

- Never commit API keys, tokens, or secrets.
- Never auto-merge PRs. Create PR only; merge is human-only.
- Never modify `manifest.json` / asset sets without diff verification (2026-05-18 incident: script deleted an entire private set).
- Never push to main without all tests passing.
- Never reintroduce OpenClaw-local classifier/asset/profile/delivery logic without an owner-approved architecture decision.

## Emotion contract

The canonical emotion set lives in `shared/emotions.ts`: `sorry`, `happy`, `confused`, `focused`, `loyalty`, `neutral`. Adding an emotion requires a roadmap decision (asset expectations, classifier behavior, generation prompt, tests). Final-response emotion selection is owned by the service verifier (a configurable remote provider — see the runbook), not a local OpenClaw classifier.
