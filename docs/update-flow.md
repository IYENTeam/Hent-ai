# Hent-ai Update Flow

This document defines how to accept Hent-ai patches and make sure the local/runtime checkout is actually updated.

## Scope

Use this flow for:

- GitHub PRs that change Hent-ai packages.
- Operator requests such as “accept the Hent-ai patch”.
- Local runtime sync after a patch has already been merged.

Do not mark an update complete until the target branch, local checkout, and relevant package checks have all been verified.

## 1. Identify the patch

Check whether there is an open PR or whether the patch already landed on `main`:

```bash
cd ~/projects/Hent-ai
git fetch --all --prune
gh pr list --repo IYENTeam/Hent-ai --state open --json number,title,headRefName,mergeStateStatus,statusCheckRollup,url
```

If no PR is open, compare local and remote `main`:

```bash
git switch main
git status --short --branch
git log --oneline main..origin/main
```

## 2. Review and accept a PR patch

For an open PR:

```bash
gh pr view <PR> --repo IYENTeam/Hent-ai --json title,state,mergeStateStatus,statusCheckRollup,additions,deletions,changedFiles
# Read the diff before approving/merging.
gh pr diff <PR> --repo IYENTeam/Hent-ai --name-only
gh pr diff <PR> --repo IYENTeam/Hent-ai --patch
```

Required gates before merge:

- GitHub checks are successful, except explicitly optional/manual jobs.
- Diff has been read enough to understand the touched package(s).
- Relevant local checks below pass.
- Large or architectural changes get owner approval before merge.

Merge only after the gates pass:

```bash
gh pr merge <PR> --squash --repo IYENTeam/Hent-ai
```

## 3. Sync local checkout after acceptance

After a PR is merged, or when a patch is already on `origin/main`:

```bash
cd ~/projects/Hent-ai
git switch main
git pull --ff-only origin main
git status --short --branch
git log --oneline -5
```

The update is not accepted locally unless `main` is clean and at the expected remote commit.

## 4. Package verification matrix

Run the smallest checks that cover the changed package. If unsure, run all package checks.

### OpenClaw plugin

```bash
cd ~/projects/Hent-ai/openclaw
npm test
npm run build
```

### Cursor package

```bash
cd ~/projects/Hent-ai/cursor
npm test
npm run build
```

### Generate package

```bash
cd ~/projects/Hent-ai/generate
npm test
npm run build
```

### Shared package

```bash
cd ~/projects/Hent-ai/shared
npm test
npm run build
```

### Hermes plugin

```bash
cd ~/projects/Hent-ai
python3 -m unittest tests.hermes.test_hent_ai_plugin
```

## 5. Runtime application

Hent-ai is loaded by OpenClaw from the local plugin path:

```text
~/projects/Hent-ai/openclaw
```

If the patch changes runtime plugin code, assets, or plugin metadata, the local checkout sync is necessary but may not be sufficient. Confirm whether the running gateway hot-reloaded plugin code. If not, schedule or request a safe gateway restart according to the current operations rules.

Do not restart the gateway from a Discord task session unless the operator explicitly asked for a restart.

## 6. Rollback / blocker handling

If verification fails:

1. Keep the working tree intact for inspection.
2. Capture the failing command and first actionable error.
3. If the patch has not merged, block merge and comment on the PR.
4. If the patch already merged, create a focused fix PR or revert PR.
5. Report the blocker with evidence; do not say the patch was accepted.

Useful commands:

```bash
git status --short --branch
git diff
gh pr checks <PR> --repo IYENTeam/Hent-ai
gh run view <RUN_ID> --repo IYENTeam/Hent-ai --log-failed
```

## 7. Completion report

A completion report must include:

- PR or commit accepted.
- Local checkout commit.
- Verification commands and pass/fail result.
- Whether runtime restart/reload was required or explicitly not performed.

Example:

```text
Accepted IYENTeam/Hent-ai#79.
Local main fast-forwarded to 8e859ff.
Verified: cursor npm test (22 passed), cursor npm run build (passed).
No gateway restart performed; patch affects package build config only.
```
