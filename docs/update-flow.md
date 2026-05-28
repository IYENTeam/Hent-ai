# Hent-ai Update Flow

This document defines the operational flow for accepting upstream Hent-ai patches and applying them to the local OpenClaw runtime checkout.

Use it for:

- GitHub PRs that change Hent-ai packages.
- Operator requests such as “accept the Hent-ai patch”.
- Local sync after a patch has already landed on `main`.

Do not mark an update complete until the upstream state, local checkout, verification commands, and runtime application decision are all recorded.

## Repository and runtime facts

- Repository: `IYENTeam/Hent-ai`
- Local checkout: `~/projects/Hent-ai`
- OpenClaw runtime plugin path: `~/projects/Hent-ai/openclaw`
- Default branch: `main`

Forbidden without explicit owner approval:

- Merging PRs.
- Restarting OpenClaw Gateway.
- Rotating credentials or changing secrets.
- Deleting data or force-pushing protected branches.

## 1. Detect the update source

Start from a clean view of the remote state:

```bash
cd ~/projects/Hent-ai
git fetch --all --prune
git status --short --branch
gh pr list --repo IYENTeam/Hent-ai --state open \
  --json number,title,headRefName,baseRefName,mergeStateStatus,statusCheckRollup,url
```

Classify the update:

- **Open PR**: review the PR and run the package checks that cover the changed paths.
- **Already merged patch**: fast-forward local `main` and verify the new local commit.
- **Patch file / local branch**: inspect the diff locally before pushing or opening a PR.

If the working tree is dirty before you start, stop and identify the owner of the existing changes. Do not overwrite or stash unrelated work silently.

## 2. Inspect PR or patch contents

For an open PR:

```bash
gh pr view <PR> --repo IYENTeam/Hent-ai \
  --json title,state,author,mergeStateStatus,additions,deletions,changedFiles,statusCheckRollup,url

gh pr diff <PR> --repo IYENTeam/Hent-ai --name-only
gh pr diff <PR> --repo IYENTeam/Hent-ai --patch
```

For a local branch or patch:

```bash
git status --short --branch
git diff --name-only main...HEAD
git diff --stat main...HEAD
git diff main...HEAD
```

Map changed paths to verification commands:

- `openclaw/**` → OpenClaw plugin checks.
- `cursor/**` → Cursor package checks.
- `generate/**` → Generate package checks.
- `shared/**` → Shared package checks plus dependent package checks when APIs changed.
- `hermes/**` or `tests/hermes/**` → Hermes plugin checks.
- `.github/**` → GitHub Actions / PR checks.
- `assets/**` or `openclaw/assets/**` → asset manifest and integration checks.
- `docs/**` or `*.md` only → documentation proofread plus CI/PR checks; package checks are optional unless commands changed.

## 3. Verification commands

Run the smallest set that covers the changed paths. If the changed paths cross package boundaries or you are unsure, run the full matrix.

### Full matrix

```bash
cd ~/projects/Hent-ai

# OpenClaw plugin
cd openclaw && npm test && cd ..

# Cursor package
cd cursor && npm test && npm run build && cd ..

# Generate package
cd generate && npm test && npm run build && cd ..

# Shared package
cd shared && npm test && cd ..

# Hermes plugin
python3 -m pytest tests/hermes/ -v
```

### CI-equivalent checks

The GitHub CI currently runs these package gates:

```bash
# OpenClaw plugin
cd ~/projects/Hent-ai/openclaw
pnpm install --no-frozen-lockfile
pnpm exec tsc --noEmit --skipLibCheck
pnpm test

# Generate module
cd ~/projects/Hent-ai/generate
npm ci
npm run build
npm test

# Hermes plugin
cd ~/projects/Hent-ai
python3 -m pytest tests/hermes/ -v

# Integration checks
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('openclaw/openclaw.plugin.json','utf8')); const required=['id','name','description','activation','configSchema']; const missing=required.filter(k=>!m[k]); if(missing.length){throw new Error('Missing manifest fields: '+missing.join(','));} console.log('manifest ok', m.id);"
find assets -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.webp' \) | wc -l
```

### Package-specific quick checks

Use these when a patch only touches one package:

```bash
# OpenClaw plugin
cd ~/projects/Hent-ai/openclaw
npm test
pnpm exec tsc --noEmit --skipLibCheck

# Cursor package
cd ~/projects/Hent-ai/cursor
npm test
npm run build

# Generate package
cd ~/projects/Hent-ai/generate
npm test
npm run build

# Shared package
cd ~/projects/Hent-ai/shared
npm test

# Hermes plugin
cd ~/projects/Hent-ai
python3 -m pytest tests/hermes/ -v
```

Notes:

- `shared` has no build script today; `npm test` is the exact package check.
- `openclaw` has no `build` script today; use `pnpm exec tsc --noEmit --skipLibCheck` for type checking.
- If `shared` exports/types change, also run dependent package checks for `openclaw`, `cursor`, and `generate`.

## 4. Accept an upstream PR

Before merge, all gates must be true:

- Diff was read and changed packages are understood.
- Required local checks passed or the PR's GitHub checks cover the same commands.
- `mergeStateStatus` is not blocked by conflicts or failing required checks.
- Large, architectural, secret, deployment, or runtime-restart-impacting changes have owner approval.

Check PR status:

```bash
gh pr checks <PR> --repo IYENTeam/Hent-ai
gh pr view <PR> --repo IYENTeam/Hent-ai --json mergeStateStatus,statusCheckRollup,url
```

Merge only with explicit owner approval when the current operating rules require it:

```bash
gh pr merge <PR> --squash --repo IYENTeam/Hent-ai
```

If approval is not present, leave the PR open and report the verification evidence and the missing approval.

## 5. Sync local checkout after acceptance

After a PR is merged, or when the patch is already on `origin/main`:

```bash
cd ~/projects/Hent-ai
git switch main
git fetch origin main
git pull --ff-only origin main
git status --short --branch
git rev-parse --short HEAD
git log --oneline -5
```

The local update is not complete unless `main` is clean and at the expected remote commit.

If the local checkout is intentionally on a task branch, do not switch branches blindly. Record that local runtime sync is blocked by the active task branch, or use a separate clean worktree.

## 6. Runtime application decision

After local sync, decide whether runtime action is needed:

- **Docs/tests only**: no runtime action.
- **Package code used by OpenClaw plugin**: local checkout sync may be enough if OpenClaw loads TypeScript/source dynamically; otherwise schedule a safe restart.
- **Plugin manifest/config schema/assets**: verify whether the running gateway has reloaded the plugin metadata/assets.
- **Dependency or lockfile changes**: install dependencies in the affected package before expecting runtime behavior to change.

Useful local checks:

```bash
cd ~/projects/Hent-ai/openclaw
git status --short --branch
npm ls --depth=0
```

Do not restart OpenClaw Gateway from a Discord task session unless the operator explicitly asked for a restart. If a restart is needed, report it as a blocker with the commit and verification evidence.

## 7. Rollback and blocker handling

### If verification fails before merge

1. Keep the working tree intact.
2. Capture the failing command, exit code, and first actionable error.
3. Block merge.
4. Comment on the PR or open a focused fix PR, depending on ownership and scope.

```bash
git status --short --branch
gh pr checks <PR> --repo IYENTeam/Hent-ai
gh run view <RUN_ID> --repo IYENTeam/Hent-ai --log-failed
```

### If the patch already merged but local verification fails

1. Do not report the update as accepted locally.
2. Create a focused fix PR when the cause is clear.
3. Create a revert PR when the merged patch breaks runtime and a focused fix is unsafe.
4. Leave the local runtime on the last known-good commit if rollback is required.

```bash
cd ~/projects/Hent-ai
git switch -c fix/<short-problem>
# apply focused fix
git diff
git commit -am "fix: <short problem>"
git push -u origin fix/<short-problem>
gh pr create --repo IYENTeam/Hent-ai --title "fix: <short problem>" --body "..."
```

For a revert PR:

```bash
cd ~/projects/Hent-ai
git switch main
git pull --ff-only origin main
git switch -c revert/<bad-commit>
git revert <bad-commit>
git push -u origin revert/<bad-commit>
gh pr create --repo IYENTeam/Hent-ai --title "revert: <bad change>" --body "..."
```

### Blocker report must include

- Patch identifier: PR number, branch, or commit.
- Failing command and exit code.
- Error excerpt.
- Current local commit.
- Whether runtime was changed. If not changed, say so explicitly.

## 8. Completion report

A completion report must include:

- Accepted PR or commit.
- Local checkout branch and commit.
- Verification commands with pass/fail result.
- Runtime action taken, or explicit note that no restart/reload was performed.
- Rollback/fix PR link if applicable.

Example:

```text
Accepted IYENTeam/Hent-ai#79.
Local main fast-forwarded to 8e859ff.
Verified: cursor npm test (22 passed), cursor npm run build (passed).
Runtime: no gateway restart; patch affects Cursor build config only.
Blockers: none.
```
