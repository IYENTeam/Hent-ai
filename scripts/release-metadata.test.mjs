import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildReleasePlan,
  inspectRelease,
  parseReleaseVersion,
  ReleaseMetadataError,
} from "./release-metadata.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "hent-ai-release-metadata-"));
  await mkdir(join(root, "openclaw"));
  await writeFile(join(root, "openclaw/package.json"), '{"version":"2026.5.6"}\n');
  await writeFile(join(root, "tracked.txt"), "release fixture\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release-test@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
  const targetSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, targetSha };
}

function input(overrides = {}) {
  return {
    version: "2026.5.6",
    packageVersion: "2026.5.6",
    targetSha: sha,
    mainSha: sha,
    tagSha: undefined,
    releaseExists: false,
    dryRun: false,
    ...overrides,
  };
}

test("valid release metadata creates an absent tag", () => {
  // Given: a valid calendar version and current-main target with no tag.
  // When: the release plan is built.
  const plan = buildReleasePlan(input());
  // Then: a new immutable version tag is planned.
  assert.deepEqual(plan, {
    version: "2026.5.6",
    tag: "v2026.5.6",
    targetSha: sha,
    action: "create",
    dryRun: false,
  });
});

test("malformed and empty versions are rejected", () => {
  // Given: malformed boundary inputs.
  // When/Then: neither parses as a release version.
  for (const version of ["", "2026.05.6", "2026.13.0", "v2026.5.6", "2026.5.-1"]) {
    assert.throws(() => parseReleaseVersion(version), ReleaseMetadataError);
  }
});

test("package version mismatch is rejected", () => {
  // Given: a valid version that differs from the package metadata.
  // When/Then: release planning fails.
  assert.throws(() => buildReleasePlan(input({ version: "2026.5.7" })), /does not equal openclaw package version/);
});

test("stale target SHA is rejected", () => {
  // Given: a target that is not current main.
  // When/Then: release planning fails before any write action exists.
  assert.throws(() => buildReleasePlan(input({ targetSha: otherSha })), /is not current main/);
});

test("same-SHA annotated tag resumes a missing release", () => {
  // Given: the annotated tag already exists at the target after an interruption.
  // When: no GitHub release exists yet.
  const plan = buildReleasePlan(input({ tagType: "tag", tagSha: sha }));
  // Then: the release safely resumes without recreating the tag.
  assert.equal(plan.action, "resume");
});

test("different-SHA annotated tag fails closed", () => {
  // Given: the immutable version tag already names another commit.
  // When/Then: release planning refuses to move it.
  assert.throws(
    () => buildReleasePlan(input({ tagType: "tag", tagSha: otherSha })),
    /already points to different SHA/,
  );
});

test("existing same-SHA annotated release is an idempotent no-op", () => {
  // Given: both tag and GitHub release already exist for the target.
  // When: the release is planned again.
  const plan = buildReleasePlan(input({ tagType: "tag", tagSha: sha, releaseExists: true }));
  // Then: no publication action is requested.
  assert.equal(plan.action, "noop");
});

test("dry-run returns the exact plan without changing its action", () => {
  // Given: valid metadata in dry-run mode.
  // When: the release is planned.
  const plan = buildReleasePlan(input({ dryRun: true }));
  // Then: the plan is observable and remains non-mutating for its caller.
  assert.equal(plan.action, "create");
  assert.equal(plan.dryRun, true);
});

test("CLI inspection distinguishes absent, resumable, and existing release state locally", async (context) => {
  // Given: a disposable current-main repository with no network dependency.
  const fixture = await createRepository();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const argv = ["--version", "2026.5.6", "--target-sha", fixture.targetSha, "--dry-run"];

  // When: no tag exists, then a same-SHA annotated tag exists with and without a release.
  const absent = await inspectRelease(argv, { root: fixture.root });
  execFileSync("git", ["tag", "-a", "v2026.5.6", fixture.targetSha, "-m", "fixture tag"], { cwd: fixture.root });
  const resumed = await inspectRelease(argv, {
    root: fixture.root,
    releaseExists: async () => false,
  });
  const existing = await inspectRelease(argv, {
    root: fixture.root,
    releaseExists: async () => true,
  });

  // Then: the three idempotency states remain distinct and dry-run stays observable.
  assert.equal(absent.action, "create");
  assert.equal(resumed.action, "resume");
  assert.equal(existing.action, "noop");
  assert.equal(existing.dryRun, true);
});

test("different-SHA tags fail before any GitHub release lookup", async (context) => {
  // Given: the requested version tag points to an older commit.
  const fixture = await createRepository();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.root, "tracked.txt"), "second commit\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: fixture.root });
  execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: fixture.root });
  const mainSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim();
  execFileSync("git", ["tag", "-a", "v2026.5.6", fixture.targetSha, "-m", "stale tag"], { cwd: fixture.root });
  let lookupCalled = false;

  // When/Then: local immutable-tag validation rejects the state before the external seam.
  await assert.rejects(
    inspectRelease(["--version", "2026.5.6", "--target-sha", mainSha], {
      root: fixture.root,
      releaseExists: async () => {
        lookupCalled = true;
        return false;
      },
    }),
    /already points to different SHA/,
  );
  assert.equal(lookupCalled, false);
});

test("lightweight tags fail before any GitHub release lookup", async (context) => {
  // Given: a same-SHA tag whose object is a commit rather than an annotated tag object.
  const fixture = await createRepository();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  execFileSync("git", ["tag", "v2026.5.6", fixture.targetSha], { cwd: fixture.root });
  let lookupCalled = false;

  // When/Then: local tag-integrity validation rejects it before the external release seam.
  await assert.rejects(
    inspectRelease(["--version", "2026.5.6", "--target-sha", fixture.targetSha], {
      root: fixture.root,
      releaseExists: async () => {
        lookupCalled = true;
        return false;
      },
    }),
    /must be an annotated tag/,
  );
  assert.equal(lookupCalled, false);
});
