# Hent-ai Technical Insufficiency Inventory

Audit date: 2026-05-18 (Asia/Seoul)  
Scope: root config, GitHub workflows, `generate`, `openclaw`, `cursor`, `hermes`, assets, tests, docs, lockfiles, package/install surfaces, committed build artifacts, stubs/mocks.  
Mode: audit-only. No implementation/source fixes were made.

## Executive summary

The repository has working local tests for `generate`, `cursor`, `openclaw`, and Hermes when run with the right local setup, but the install/release contract is materially weaker than the source-tree tests suggest. The most important release blockers are package artifact path mismatches and OpenClaw package contents: `generate` publishes no usable declared `bin`/`exports` path after build, `cursor` publishes a declared CLI bin that is not produced by its build, and `openclaw` publishes only four files while `index.ts` imports runtime modules from `onboarding/` and `assets/` that are omitted from the tarball. CI further masks OpenClaw type/lint/coverage regressions by downgrading them to warnings after mutating `package.json`.

The second major theme is parity drift. Cursor has richer Korean/English classifier rules and tests, OpenClaw has custom rules and preprocessing, and Hermes is fixed-rule only with a sparse config surface. Docs present all platforms as a coherent Hent-ai family, but behavior and extension points are not contract-locked across runtimes.

## Release blockers

| ID | Severity | Bucket | Area | Summary | Fix difficulty |
|---|---|---|---|---|---|
| HENT-AUDIT-001 | critical | observed-local | packaging | `generate` package declares `./dist/main.js` and `./dist/index.js`, but build emits under `dist/generate/src/` | M |
| HENT-AUDIT-002 | critical | observed-local | packaging | `cursor` package declares `bin/hent-ai.js`, but build/pack do not include it | S |
| HENT-AUDIT-003 | critical | observed-local | packaging | OpenClaw tarball omits imported `onboarding/` and `assets/` runtime modules | M |
| HENT-AUDIT-004 | high | observed-workflow-config | ci | OpenClaw CI soft-fails typecheck/lint/coverage | S |
| HENT-AUDIT-005 | high | observed-local | build | OpenClaw docs claim `pnpm run build`; package has no build script | S |
| HENT-AUDIT-006 | high | observed-local | packaging | OpenClaw isolated install fails on `workspace:*` dependency | M |

## Full findings table

| ID | Severity | Category | Bucket | Title | Impact | Difficulty |
|---|---|---|---|---|---|---|
| HENT-AUDIT-001 | critical | packaging | observed-local | Generate package declares missing dist entrypoints | npm-installed CLI/library unusable | M |
| HENT-AUDIT-002 | critical | packaging | observed-local | Cursor package declares missing CLI bin | `npx hent-ai-cursor ...` can fail | S |
| HENT-AUDIT-003 | critical | packaging | observed-local | OpenClaw tarball omits runtime imports | Published extension cannot load | M |
| HENT-AUDIT-004 | high | ci | observed-workflow-config | CI downgrades OpenClaw quality gates | Broken types/lint/coverage can merge | S |
| HENT-AUDIT-005 | high | build | observed-local | OpenClaw documented build script missing | Onboarding/install docs fail | S |
| HENT-AUDIT-006 | high | packaging | observed-local | OpenClaw dependency topology not installable with npm | Clean install fails outside expected workspace | M |
| HENT-AUDIT-007 | high | ci | observed-workflow-config | CI mutates package manifest before install | CI validates a different dependency graph | M |
| HENT-AUDIT-008 | high | ci | observed-workflow-config | Cursor omitted from CI | Cursor build/test/package regressions are un-gated | S |
| HENT-AUDIT-009 | high | docs-parity | observed-local | Cursor classifier has Korean rules missing in OpenClaw/Hermes | Same text maps to different emotions | M |
| HENT-AUDIT-010 | medium | test | observed-workflow-config | OpenClaw test/type aliases mask runtime package contracts | Tests pass with stubs/source aliases | M |
| HENT-AUDIT-011 | medium | test | observed-workflow-config | Coverage scopes are too narrow | Important code paths are unmeasured | S |
| HENT-AUDIT-012 | medium | runtime | observed-local | Onboarding trigger regex can hijack normal chat | Unintended onboarding starts | M |
| HENT-AUDIT-013 | medium | maintainability | observed-local | Onboarding parser contains mojibake token | Korean intent matching can drift silently | S |
| HENT-AUDIT-014 | medium | reliability | observed-local | Session persistence errors are swallowed | Corruption/state loss is hard to diagnose | S |
| HENT-AUDIT-015 | medium | security | observed-local | User text feeds generation prompts with limited normalization | Prompt abuse/quality/safety risk | M |
| HENT-AUDIT-016 | medium | reliability | inferred-external | Discord/API request paths lack robust retry/backoff | Rate-limit/latency cascades under load | L |
| HENT-AUDIT-017 | medium | runtime | observed-local | Generate path uses private ChatGPT/Codex backend and auth shape | Fragile to upstream auth/API changes | M |
| HENT-AUDIT-018 | medium | reliability | observed-local | Generate writes partial output without transaction/resume | Failed runs leave mixed asset state | M |
| HENT-AUDIT-019 | medium | docs-parity | observed-workflow-config | Classifier customization docs are uneven across platforms | Users cannot predict extension points | S |
| HENT-AUDIT-020 | medium | ci | observed-workflow-config | PR checks warn for manifest/entrypoint contract changes | Breaking changes can pass PR checks | S |
| HENT-AUDIT-021 | low | dx | observed-local | Root package has no scripts/metadata | No single repo-level verification command | S |
| HENT-AUDIT-022 | low | packaging | observed-local | Hermes has no Python package manifest | Distribution lifecycle is clone/copy only | M |
| HENT-AUDIT-023 | low | security | observed-local | Onboarding persists session metadata as plain JSON | Local metadata exposure risk | M |
| HENT-AUDIT-024 | low | docs-parity | observed-workflow-config | `generate` has no package-local README | Package docs parity cannot be audited locally | S |
| HENT-AUDIT-025 | low | maintainability | inferred-external | Mixed package managers/toolchains | Reproducibility risk across local/CI | M |

## Detailed findings

### HENT-AUDIT-001 — Generate package declares missing dist entrypoints
- Severity: critical
- Category: packaging
- Evidence bucket: observed-local
- Evidence: `generate/package.json:6-13` declares `bin.hent-ai = ./dist/main.js`, `exports["."] = ./dist/index.js`, and `files = ["dist"]`. `npm --prefix generate run build` passed, but `npm pack --dry-run --json` from `generate/` listed `dist/generate/src/main.js` and `dist/generate/src/index.js`, not the declared paths. `command-logs/generate-bin-exists.log` recorded `generate_bin_expected_exists=1` for `generate/dist/main.js`.
- Impacted files: `generate/package.json`, `generate/tsconfig.json`, generated package tarball layout.
- User/release impact: Installed package consumers and `hent-ai` CLI resolve missing entrypoints even though local build/test pass.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Align `rootDir`/`outDir` or package `bin`/`exports` paths, then verify with `npm pack --dry-run` and an install smoke test.

### HENT-AUDIT-002 — Cursor package declares missing CLI bin
- Severity: critical
- Category: packaging
- Evidence bucket: observed-local
- Evidence: `cursor/package.json:7-13` declares `bin.hent-ai = ./bin/hent-ai.js` and includes it in `files`. Source tree has `cursor/bin/install.ts`; after `npm --prefix cursor run build`, `command-logs/cursor-bin-exists.log` recorded `cursor_bin_exists=1` and `cursor_dist_cli_exists=0`, meaning the expected bin is absent while `dist-cli/install.js` exists. `cursor-pack-dry-cwd.log` listed `dist-cli/install.js` and assets, but no `bin/hent-ai.js`.
- Impacted files: `cursor/package.json`, `cursor/bin/install.ts`, `cursor/tsconfig.cli.json`.
- User/release impact: `npx hent-ai-cursor install/status/uninstall` can install a package without the declared executable.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Either emit/copy a `bin/hent-ai.js` wrapper or point `bin` to the built CLI file and re-run pack/install smoke tests.

### HENT-AUDIT-003 — OpenClaw tarball omits imported runtime modules
- Severity: critical
- Category: packaging
- Evidence bucket: observed-local
- Evidence: `openclaw/package.json:10-14` packages only `index.ts`, `openclaw.plugin.json`, and `README.md`. `openclaw/index.ts:8-11` imports `./onboarding/discord-utils.js`, `./onboarding/index.js`, `./assets/manifest.js`, and `./assets/channel-overrides.js`. `command-logs/openclaw-pack-dry-cwd.log` listed only four files in the tarball. `command-logs/openclaw-files-exist.log` confirmed those imported source files exist locally but are not included in package `files`.
- Impacted files: `openclaw/package.json`, `openclaw/index.ts`, `openclaw/onboarding/**`, `openclaw/assets/**`.
- User/release impact: Published or packed OpenClaw extension cannot resolve its own runtime imports.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Include all runtime modules/assets or build to a complete dist package and verify by unpacking/installing the tarball.

### HENT-AUDIT-004 — CI downgrades OpenClaw quality gates
- Severity: high
- Category: ci
- Evidence bucket: observed-workflow-config
- Evidence: `.github/workflows/ci.yml:52-56` runs typecheck/lint with `|| echo "::warning::..."`; `.github/workflows/ci.yml:61-62` does the same for coverage. Local `command-logs/openclaw-typecheck.log` failed with TypeScript 6 deprecation error TS5101, which this CI line would downgrade to a warning.
- Impacted files: `.github/workflows/ci.yml`, `openclaw/tsconfig.json`.
- User/release impact: Static regressions can pass branch protection if only these CI jobs are required.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Make typecheck/lint/coverage hard gates after fixing dependency/tooling availability.

### HENT-AUDIT-005 — OpenClaw documented build script is missing
- Severity: high
- Category: build
- Evidence bucket: observed-local
- Evidence: `openclaw/README.md:126-139` instructs users to run `pnpm run build`. `openclaw/package.json:15-18` defines only `test` and `test:watch`. `command-logs/openclaw-build.log` shows `npm error Missing script: "build"`.
- Impacted files: `openclaw/README.md`, `openclaw/package.json`.
- User/release impact: Source install/onboarding instructions fail at the documented validation step.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Add a real build/typecheck script or update docs to the actual OpenClaw extension loading workflow.

### HENT-AUDIT-006 — OpenClaw dependency topology is not npm-installable in isolation
- Severity: high
- Category: packaging
- Evidence bucket: observed-local
- Evidence: `openclaw/package.json:19-27` uses `@hent-ai/generate: file:../generate` and `@openclaw/plugin-sdk: workspace:*`. `command-logs/openclaw-npm-install.log` failed with `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:": workspace:*`.
- Impacted files: `openclaw/package.json`, lockfiles/workspace assumptions.
- User/release impact: Users or CI using npm in `openclaw/` cannot install dependencies cleanly; package portability depends on a specific workspace toolchain.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Decide whether OpenClaw is source-only workspace code or publishable package; align dependency spec and CI accordingly.

### HENT-AUDIT-007 — CI mutates OpenClaw package manifest before install
- Severity: high
- Category: ci
- Evidence bucket: observed-workflow-config
- Evidence: `.github/workflows/ci.yml:36-47` rewrites `openclaw/package.json` and deletes every dependency whose name starts with `@openclaw/` before install.
- Impacted files: `.github/workflows/ci.yml`, `openclaw/package.json`.
- User/release impact: CI validates a dependency graph different from committed source and can miss real install/runtime failures.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Use a workspace-aware install or explicit CI stubs without mutating the committed package contract.

### HENT-AUDIT-008 — Cursor is omitted from CI
- Severity: high
- Category: ci
- Evidence bucket: observed-workflow-config
- Evidence: `.github/workflows/ci.yml:14-203` defines `openclaw`, `generate`, `hermes`, and `integration`; there is no `cursor` job. Local `cursor` build/test passed, but package-bin mismatch was only found by manual audit.
- Impacted files: `.github/workflows/ci.yml`, `cursor/**`.
- User/release impact: Cursor package regressions can merge unnoticed.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Add CI job for `npm ci`, build, test, pack dry-run, and bin smoke test in `cursor/`.

### HENT-AUDIT-009 — Classifier behavior differs materially across Cursor, OpenClaw, and Hermes
- Severity: high
- Category: docs-parity
- Evidence bucket: observed-local
- Evidence: `cursor/src/classifier/ruleClassifier.ts:7-39` includes Korean patterns and richer English matching; `openclaw/index.ts:638-672` and `hermes/__init__.py:35-72` are English-centric. Cursor tests cover the classifier in `cursor/test/classifier.test.ts`; Hermes tests cover only English examples in `tests/hermes/test_hent_ai_plugin.py:15-25`.
- Impacted files: `cursor/src/classifier/ruleClassifier.ts`, `openclaw/index.ts`, `hermes/__init__.py`, tests/docs.
- User/release impact: The same Korean or mixed-language response can render different emotion images depending on platform.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Extract/define a shared classifier contract or parity test fixture set for all runtimes.

### HENT-AUDIT-010 — OpenClaw aliases/stubs mask runtime contracts
- Severity: medium
- Category: test
- Evidence bucket: observed-workflow-config
- Evidence: `openclaw/tsconfig.json:16-18` maps `@hent-ai/generate` to source and SDK entry to `test/stubs/plugin-entry.ts`; `openclaw/vitest.config.ts:8-12` maps `@hent-ai/generate` to `openclaw/test/stubs/generate.ts`. The stub returns `Buffer.from("FAKE_PNG_DATA")` in `openclaw/test/stubs/generate.ts:1-3`.
- Impacted files: `openclaw/tsconfig.json`, `openclaw/vitest.config.ts`, `openclaw/test/stubs/*`.
- User/release impact: Tests can pass while package resolution, real generate options, or SDK contract fail.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Add at least one package-resolution/integration smoke test that uses built/packed artifacts or a realistic SDK shim.

### HENT-AUDIT-011 — Coverage scopes are too narrow
- Severity: medium
- Category: test
- Evidence bucket: observed-workflow-config
- Evidence: `generate/vitest.config.ts:7-15` enforces 100% coverage only on `src/generator.ts`; `openclaw/vitest.config.ts:17-25` enforces 100% coverage only on `onboarding/parsers.ts`. CI coverage is warning-only at `.github/workflows/ci.yml:61-62`.
- Impacted files: `generate/vitest.config.ts`, `openclaw/vitest.config.ts`, `.github/workflows/ci.yml`.
- User/release impact: Important CLI, Codex backend, Discord, manifest, and package-boundary paths remain outside coverage gates.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Broaden coverage include sets and separate threshold ratcheting from initial reporting.

### HENT-AUDIT-012 — Onboarding trigger matching can misfire
- Severity: medium
- Category: runtime
- Evidence bucket: observed-local
- Evidence: `openclaw/onboarding/parsers.ts:40-49` uses broad trigger/action regexes; trigger handling is consumed by the onboarding runtime per subagent inspection of `openclaw/onboarding/index.ts:84-90`.
- Impacted files: `openclaw/onboarding/parsers.ts`, `openclaw/onboarding/index.ts`.
- User/release impact: Ordinary messages mentioning bot/image/setup concepts can unexpectedly start onboarding.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Narrow trigger grammar, require explicit command/channel mode, and add false-positive tests.

### HENT-AUDIT-013 — Onboarding parser contains mojibake token
- Severity: medium
- Category: maintainability
- Evidence bucket: observed-local
- Evidence: `openclaw/onboarding/parsers.ts:10` includes `���ㅋ` in the positive intent regex.
- Impacted files: `openclaw/onboarding/parsers.ts`.
- User/release impact: Encoding corruption can reduce Korean matching quality and signals weak text-fixture review.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Replace corrupted token with intended Korean slang and add encoding-safe tests.

### HENT-AUDIT-014 — Session persistence errors are swallowed
- Severity: medium
- Category: reliability
- Evidence bucket: observed-local
- Evidence: `openclaw/onboarding/session.ts:75-92` catches restore failures with an empty `catch {}`; `openclaw/onboarding/session.ts:110-112` also swallows unlink errors.
- Impacted files: `openclaw/onboarding/session.ts`.
- User/release impact: Corrupt session files or filesystem permission failures cause silent state loss and difficult support/debugging.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Log structured warnings and quarantine/delete corrupt files deliberately.

### HENT-AUDIT-015 — User text feeds generation prompts with limited normalization
- Severity: medium
- Category: security
- Evidence bucket: observed-local
- Evidence: `openclaw/onboarding/flow.ts:326-435` builds base/emotion generation prompts from `session.character` and feedback and passes them to `generateImage`; CLI `generate/src/cli.ts:27-82` accepts character/size/model strings with minimal validation.
- Impacted files: `openclaw/onboarding/flow.ts`, `openclaw/onboarding/prompts.ts`, `generate/src/cli.ts`.
- User/release impact: Prompt injection or abusive prompt content can influence image generation quality/safety; operational failures surface to Discord users.
- Fix difficulty: M
- Confidence: medium
- Recommended fix direction: Add prompt-boundary templates, length limits, and explicit validation/sanitization for user-controlled fields.

### HENT-AUDIT-016 — Discord/API request paths lack robust retry/backoff
- Severity: medium
- Category: reliability
- Evidence bucket: inferred-external
- Evidence: `openclaw/index.ts:994-1013`, `1043-1062`, and `1249-1306` issue Discord fetches and log failures; no explicit retry-after handling/backoff is visible in these paths. Live Discord rate-limit behavior was not exercised locally.
- Impacted files: `openclaw/index.ts`, `openclaw/onboarding/discord-utils.ts`.
- User/release impact: Bursts or upstream throttling can lose image attachments and create noisy partial failures.
- Fix difficulty: L
- Confidence: medium
- Recommended fix direction: Centralize Discord API client behavior with timeout, retry-after, idempotency, and structured error handling.

### HENT-AUDIT-017 — Generate depends on private Codex/ChatGPT backend/auth shape
- Severity: medium
- Category: runtime
- Evidence bucket: observed-local
- Evidence: `generate/src/codex.ts:100-118` reads `~/.codex/auth.json` and parses it without guarding invalid JSON; `generate/src/codex.ts:134-139` targets `https://chatgpt.com/backend-api/codex` with originator `codex_cli_rs`; non-SSE response parsing uses raw `JSON.parse` at `generate/src/codex.ts:199`.
- Impacted files: `generate/src/codex.ts`, docs referencing Codex login.
- User/release impact: Upstream auth/API changes or malformed local auth can break generation with low-actionability errors.
- Fix difficulty: M
- Confidence: medium
- Recommended fix direction: Treat this as an external integration contract; add clearer errors, schema guards, and versioned compatibility docs.

### HENT-AUDIT-018 — Generate leaves partial output on failures
- Severity: medium
- Category: reliability
- Evidence bucket: observed-local
- Evidence: `generate/src/generator.ts:79-123` creates output directory and writes `base.png`/emotion PNGs sequentially as each call succeeds; if a later generation fails, earlier outputs remain in place with no manifest/checkpoint or rollback.
- Impacted files: `generate/src/generator.ts`, generated asset dirs.
- User/release impact: Users can mistake mixed old/new/partial assets for a complete coherent emotion set.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Write to a temp set directory plus manifest, then atomically activate when all required emotions exist.

### HENT-AUDIT-019 — Classifier customization docs are uneven
- Severity: medium
- Category: docs-parity
- Evidence bucket: observed-workflow-config
- Evidence: OpenClaw exposes custom `emotionRules` in `openclaw/openclaw.plugin.json:72-79` and docs at `openclaw/README.md:157-166`. `cursor/README.md:44-72` documents only the installed rule behavior/custom images. `hermes/README.md:31-48` documents env vars but no rule extension contract.
- Impacted files: `openclaw/README.md`, `cursor/README.md`, `hermes/README.md`, manifests.
- User/release impact: Users cannot predict which platform supports custom classifier behavior.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Publish a shared behavior matrix and either align extension points or explicitly document platform differences.

### HENT-AUDIT-020 — PR checks warn instead of validating breaking contracts
- Severity: medium
- Category: ci
- Evidence bucket: observed-workflow-config
- Evidence: `.github/workflows/pr-checks.yml:60-82` warns/notices on manifest and entrypoint changes; only asset deletion hard-fails.
- Impacted files: `.github/workflows/pr-checks.yml`.
- User/release impact: Contract-breaking config/schema/entrypoint changes can pass PR checks without hard validation.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Add schema compatibility checks and package/install smoke checks for contract-bearing files.

### HENT-AUDIT-021 — Root package has no standard scripts
- Severity: low
- Category: dx
- Evidence bucket: observed-local
- Evidence: `package.json:1-6` contains only devDependencies. `command-logs/root-npm-test.log` failed with `Missing script: "test"`; `command-logs/root-tsc.log` showed TypeScript help because no root tsconfig/project is present.
- Impacted files: root `package.json`.
- User/release impact: Contributors and automation have no single repo-level `test`, `build`, or `typecheck` contract.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Add root orchestration scripts or document that verification must be run per package.

### HENT-AUDIT-022 — Hermes has no Python package manifest
- Severity: low
- Category: packaging
- Evidence bucket: observed-local
- Evidence: `hermes/plugin.yaml:1-5` and `hermes/__init__.py` define plugin behavior, but no `hermes/pyproject.toml`/`setup.py` exists. `hermes/README.md:7-28` uses clone/symlink/copy installation.
- Impacted files: `hermes/**`.
- User/release impact: Hermes installation is manual and hard to validate with standard Python packaging tooling.
- Fix difficulty: M
- Confidence: high
- Recommended fix direction: Keep clone/copy as explicit support model or add package metadata if distribution is intended.

### HENT-AUDIT-023 — Onboarding persists session metadata as plain JSON
- Severity: low
- Category: security
- Evidence bucket: observed-local
- Evidence: `openclaw/onboarding/session.ts:51-60` enables persistent sessions, and `openclaw/onboarding/session.ts:95-107` writes serialized session data including user/channel/workspace metadata as JSON.
- Impacted files: `openclaw/onboarding/session.ts`.
- User/release impact: Local files may expose user IDs, channel IDs, workspace paths, and interaction timing.
- Fix difficulty: M
- Confidence: medium
- Recommended fix direction: Document storage location/contents, set restrictive permissions where possible, and avoid persisting unnecessary metadata.

### HENT-AUDIT-024 — `generate` lacks package-local README
- Severity: low
- Category: docs-parity
- Evidence bucket: observed-workflow-config
- Evidence: `generate/src/*` and `generate/package.json` exist, but there is no `generate/README.md`; root README contains generate instructions at `README.md:31-74`.
- Impacted files: `generate/**`, root `README.md`.
- User/release impact: npm/package consumers lack package-local usage and compatibility documentation.
- Fix difficulty: S
- Confidence: high
- Recommended fix direction: Add or publish package-local docs synchronized with root README.

### HENT-AUDIT-025 — Mixed package managers/toolchains reduce reproducibility
- Severity: low
- Category: maintainability
- Evidence bucket: inferred-external
- Evidence: `.github/workflows/ci.yml:31-50` uses pnpm for OpenClaw; `.github/workflows/ci.yml:87-100` uses npm for generate; `.github/workflows/ci.yml:132-138` uses pip/pytest for Hermes. Root includes both `package-lock.json` and `pnpm-lock.yaml`.
- Impacted files: lockfiles, `.github/workflows/ci.yml`, package manifests.
- User/release impact: Contributors can reproduce different dependency graphs depending on package manager and working directory.
- Fix difficulty: M
- Confidence: medium
- Recommended fix direction: Declare supported package manager per package or standardize workspace tooling.

## Verification log

Commands were run non-mutating with respect to intended source changes, though local build/install tools created ignored dependency/build artifacts. Full captured logs are under `.omx/reports/command-logs/`.

| Command | Result | Evidence log |
|---|---:|---|
| `npm --prefix generate ci` | PASS | `generate-npm-ci.log` |
| `npm --prefix generate run build` | PASS | `generate-build.log` |
| `npm --prefix generate test` | PASS, 23 tests | `generate-test.log` |
| `(cd generate && npm pack --dry-run --json)` | PASS, exposed bad dist layout | `generate-pack-dry-cwd.log` |
| `npm --prefix cursor ci` | PASS | `cursor-npm-ci.log` |
| `npm --prefix cursor run build` | PASS | `cursor-build.log` |
| `npm --prefix cursor test` | PASS, 22 tests | `cursor-test.log` |
| `(cd cursor && npm pack --dry-run --json)` | PASS, exposed missing bin | `cursor-pack-dry-cwd.log` |
| `(cd openclaw && npm install --ignore-scripts)` | FAIL, `workspace:*` unsupported by npm | `openclaw-npm-install.log` |
| `npm --prefix openclaw test` | PASS, 158 tests | `openclaw-test.log` |
| `(cd openclaw && npm exec tsc -- --noEmit)` | FAIL, TS5101 deprecation from TypeScript 6 | `openclaw-typecheck.log` |
| `(cd openclaw && npm pack --dry-run --json)` | PASS, exposed omitted runtime files | `openclaw-pack-dry-cwd.log` |
| `npm --prefix openclaw run build` | FAIL, missing script | `openclaw-build.log` |
| `python -m pytest tests/hermes/ -v` | SKIPPED/FAIL locally: `python` command absent | `hermes-pytest.log` |
| `python3 -m pytest tests/hermes/ -v` | FAIL locally due third-party pytest plugin import under Python 3.9 | `hermes-pytest-python3.log` |
| `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest tests/hermes/ -v` | PASS, 8 tests | `hermes-pytest-python3-no-plugins.log` |
| `npm test` at repo root | FAIL, missing root test script | `root-npm-test.log` |
| `npm ci` at repo root | FAIL locally due npm cache permission/EEXIST | `root-npm-ci.log` |
| `npm exec tsc -- --noEmit` at repo root | FAIL/no project; printed TypeScript help | `root-tsc.log` |

## Subagent probes integrated

Subagents spawned: 3 (`019e3839-b9bd-7040-87cd-f88e10c67214` verification/package/CI, `019e3839-c8f7-7f11-946b-a6ff3259d4d5` OpenClaw runtime/onboarding, `019e3839-dfc4-77e1-9db3-728df9d0e5c7` Cursor/Hermes/classifier/docs parity).  
Subagent model: gpt-5.4-mini role defaults via Codex native subagents.  
Serial searches before spawn: 1 repo/task-plan read after claim.

Integrated findings:
- Package/CI probe highlighted missing OpenClaw build script, CI manifest mutation, soft-fail gates, Cursor CI omission, and package-manager risk.
- OpenClaw probe highlighted broad triggers, mojibake, swallowed persistence errors, prompt-input risk, alias/stub masking, and external API back-pressure risk.
- Parity probe highlighted Cursor Korean classifier support, OpenClaw-only custom rules/preprocessing, Hermes fixed rule path, and uneven docs.

## Blind spots and skipped checks

- No live Discord/OpenClaw gateway was run; Discord API behavior, OpenClaw SDK runtime loading, and gateway hook contracts are classified as `inferred-external` where not locally reproduced.
- No live Codex/ChatGPT image generation was invoked; generation backend/auth compatibility is source-observed but not end-to-end verified.
- No npm tarball was installed into a clean temporary consumer project after unpacking. `npm pack --dry-run` already exposed release blockers; an install smoke test should be added when fixing.
- Root `npm ci` failed due local npm cache permissions, so root dependency verification is not a clean product signal.
- Hermes plain pytest failed because local global pytest auto-loaded an incompatible third-party plugin under Python 3.9; disabling plugin autoload produced a clean Hermes test pass. CI uses Python 3.12 and installs only pytest, so local plugin failure is environmental, not classified as a repo release blocker.
- Source files were not edited. Build/dependency commands may have produced ignored local artifacts such as `node_modules`, `dist`, and `.pytest_cache`; the committed audit output is limited to `.omx/reports/`.

## Prioritized fix sequence

1. Fix packaging blockers: `generate` entrypoint layout, `cursor` missing bin, and OpenClaw tarball runtime file omissions.
2. Make package/install smoke tests first-class: `npm pack --dry-run`, unpack/install, CLI bin checks, and OpenClaw runtime import checks.
3. Repair OpenClaw dependency/build contract: decide workspace vs publishable package, add/update build script/docs, and remove CI package mutation.
4. Harden CI: add Cursor job, make OpenClaw type/lint/coverage hard gates, add contract checks to PR checks.
5. Establish classifier parity fixture set across Cursor/OpenClaw/Hermes, including Korean and noisy `MEDIA:` cases.
6. Broaden coverage scopes and add tests around Codex auth/JSON errors, package boundaries, onboarding false positives, and session corruption logging.
7. Address runtime reliability/security debt: Discord retry/backoff, user-prompt bounds, transactional generation output, and persisted metadata documentation/permissions.
8. Normalize contributor DX: root scripts or explicit per-package verification docs, package-local `generate` README, and package-manager guidance.

## Suggested next workflow

After report approval, use `$team .omx/reports/repo-tech-debt-audit.md` for parallel fix lanes: packaging/build, CI/test harness, OpenClaw runtime/onboarding, classifier/docs parity, and final verifier. For a smaller sequential lane, use `$ralph .omx/reports/repo-tech-debt-audit.md` and close release blockers first.
