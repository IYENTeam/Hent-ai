import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readReleaseWorkflow() {
  try {
    return await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

test("local release documentation retains the existing blocking gate", async () => {
  // Given: the original local release surfaces.
  const gate = await readFile(resolve(root, "scripts/release-gate.mjs"), "utf8");
  const runbook = await readFile(resolve(root, "docs/agent-runbook.md"), "utf8");

  // When: the preserved baseline contract is inspected.
  // Then: both original test lanes and the operator command remain documented.
  assert.match(gate, /service full regression suite/);
  assert.match(gate, /openclaw full regression suite/);
  assert.match(runbook, /node scripts\/release-gate\.mjs/);
  assert.match(runbook, /local gate/);
});

test("release workflow and full local lane contract are present", async () => {
  // Given: a release implementation must have a real trusted workflow seam.
  const workflow = await readReleaseWorkflow();

  // When: the release workflow is absent, fail on the contract rather than ENOENT.
  // Then: the failure names the missing release surface explicitly.
  assert.ok(workflow, "Release workflow missing");

  const gate = await readFile(resolve(root, "scripts/release-gate.mjs"), "utf8");
  const runbook = await readFile(resolve(root, "docs/agent-runbook.md"), "utf8");
  const requiredLaneIds = [
    "service-typescript",
    "service-tests",
    "openclaw-typescript",
    "openclaw-tests",
    "generate-build",
    "generate-tests",
    "shared-tests",
    "hermes-unittest",
    "static-contracts",
  ];

  for (const laneId of requiredLaneIds) {
    assert.match(gate, new RegExp(`id: [\"']${laneId}[\"']`), `missing lane ${laneId}`);
  }
  assert.match(gate, /--list-json/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /dry_run:/);
  assert.match(workflow, /release-v\$\{\{ inputs\.version \}\}/);
  assert.match(workflow, /contents: write/);
  assert.match(runbook, /human-only/i);
  assert.match(runbook, /dry.run/i);
});

test("list-json returns the exact nine release lanes without executing them", () => {
  // Given: the operator asks for the machine-readable gate contract.
  const result = spawnSync(process.execPath, [resolve(root, "scripts/release-gate.mjs"), "--list-json"], {
    cwd: root,
    encoding: "utf8",
  });

  // When/Then: the command succeeds with only the exact nine-lane JSON contract.
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(listed.lanes.map((lane) => lane.id), [
    "service-typescript",
    "service-tests",
    "openclaw-typescript",
    "openclaw-tests",
    "generate-build",
    "generate-tests",
    "shared-tests",
    "hermes-unittest",
    "static-contracts",
  ]);
  assert.deepEqual(listed.lanes[0].envUnset, [
    "HENT_AI_DISCORD_POLLER_TOKEN",
    "HENT_AI_DISCORD_POLLER_CHANNELS",
    "HENT_AI_DISCORD_POLLER_LIVE_SEND_CONTENT",
    "DISCORD_BOT_TOKEN",
  ]);
  assert.deepEqual(listed.lanes[1].envUnset, listed.lanes[0].envUnset);
});

test("release gate propagates a real child exit and stops before later lanes", async (context) => {
  // Given: a local executable seam makes the first child fail with a distinctive code.
  const bin = await mkdtemp(join(tmpdir(), "hent-ai-release-gate-"));
  context.after(() => rm(bin, { recursive: true, force: true }));
  const fakeNpx = join(bin, "npx");
  await writeFile(fakeNpx, "#!/bin/sh\nprintf 'first child invoked\\n'\nexit 23\n");
  await chmod(fakeNpx, 0o755);

  // When: the normal gate runs against that controlled command surface.
  const result = spawnSync(process.execPath, [resolve(root, "scripts/release-gate.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });

  // Then: the child's real code is preserved and later lanes never run.
  assert.equal(result.status, 23);
  assert.match(result.stdout, /service TypeScript/);
  assert.match(result.stdout, /first child invoked/);
  assert.doesNotMatch(result.stdout, /service full regression suite/);
  assert.match(result.stderr, /failed with exit code 23/);
});

test("trusted workflow is main-only, least-privilege, and publish-idempotent", async () => {
  // Given: the release workflow is treated as the only publishing authority.
  const workflow = await readReleaseWorkflow();
  assert.ok(workflow, "Release workflow missing");

  // When/Then: trust, immutability, resume, and no-production-side-effect contracts are explicit.
  assert.match(workflow, /DISPATCH_REF: \$\{\{ github\.ref \}\}/);
  assert.match(workflow, /"\$DISPATCH_REF" != "\$TRUSTED_MAIN_REF"/);
  assert.match(workflow, /validate:[\s\S]*?needs: trusted_dispatch/);
  assert.match(workflow, /default: true/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\n      contents: write/);
  assert.match(workflow, /git tag -a "\$TAG" "\$TARGET_SHA"/);
  assert.match(workflow, /ACTION" = "noop"/);
  assert.match(workflow, /ACTION" = "create"/);
  assert.doesNotMatch(workflow, /git (?:tag|push)[^\n]*--force/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /discord\.com|\/v1\/assets\/generate|deploy|gateway restart/i);
});

test("release authority is pinned to main even if the repository default branch changes", async () => {
  // Given: repository.default_branch is mutable repository metadata and may be changed to dev.
  const workflow = await readReleaseWorkflow();
  assert.ok(workflow, "Release workflow missing");

  // When/Then: the trusted production authority is a literal main ref in both validation phases.
  assert.match(workflow, /TRUSTED_MAIN_REF: refs\/heads\/main/);
  assert.match(workflow, /"\$DISPATCH_REF" != "\$TRUSTED_MAIN_REF"/);
  assert.equal(workflow.match(/refs\/heads\/main:refs\/remotes\/origin\/main/g)?.length, 2);
  assert.equal(workflow.match(/MAIN_REF: refs\/remotes\/origin\/main/g)?.length, 2);
  assert.doesNotMatch(workflow, /repository\.default_branch/);

  // A dispatch from dev remains denied regardless of any external default-branch setting.
  const denied = spawnSync("sh", ["-c", 'test "$DISPATCH_REF" = "$TRUSTED_MAIN_REF"'], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISPATCH_REF: "refs/heads/dev",
      TRUSTED_MAIN_REF: "refs/heads/main",
      REPOSITORY_DEFAULT_BRANCH: "dev",
    },
  });
  assert.notEqual(denied.status, 0);
});

test("operator docs preserve rollback ancestry and the conflicted PR handoff", async () => {
  const process = await readFile(resolve(root, "docs/release-process.md"), "utf8");

  assert.match(process, /revert[^\n]*`main`[\s\S]*?`main`[^\n]*`release`[\s\S]*?`release`[^\n]*`dev`/i);
  assert.match(process, /PR #115[\s\S]*?current `dev`[\s\S]*?node scripts\/release-gate\.mjs/);
  assert.match(
    process,
    /PR #115[\s\S]*?--force-with-lease=refs\/heads\/codex\/hent-ai-service-hardening:01a4c61968eb57e2c652ce66235a805c82d4cf0c/,
  );
  assert.match(process, /PR #119[\s\S]*?after PR #115 is\s+human-merged[\s\S]*?human-only/i);
});
