import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  new URL("../.github/workflows/pr-checks.yml", import.meta.url),
  "utf8",
);
let policyWorkflow;
try {
  policyWorkflow = readFileSync(
    new URL("../.github/workflows/branch-flow-policy.yml", import.meta.url),
    "utf8",
  );
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}
const policyPath = fileURLToPath(
  new URL("./branch-flow-policy.mjs", import.meta.url),
);

function runPolicy(base, head) {
  return spawnSync(
    process.execPath,
    [policyPath, "--base", base, "--head", head],
    { encoding: "utf8" },
  );
}

test("preserves the current-head owner gate and asset-deletion block", () => {
  // Given: the existing PR checks workflow.
  // When: its protected review and asset checks are inspected.
  // Then: controlled-label, current-head approval, and deletion behavior stay pinned.
  assert.match(
    workflow,
    /OWNER_REVIEW_LABEL: owner-reviewed/,
  );
  assert.match(
    workflow,
    /HEAD_SHA="\$\{\{ github\.event\.pull_request\.head\.sha \}\}"/,
  );
  assert.match(workflow, /\.commit_id == \$head_sha/);
  assert.match(workflow, /map\(select\(\.state == "APPROVED"\)\)/);
  assert.match(workflow, /git diff --name-only --diff-filter=D/);
  assert.match(workflow, /::error::Asset files removed/);
});

test("uses PR base and head SHAs without executing branch policy from PR code", () => {
  // Given: a PR whose base may not be main.
  // When: size, breaking-change, asset, and branch-flow checks are inspected.
  // Then: every diff uses the immutable PR SHA range and this workflow owns no policy job.
  const pullRequestRange =
    "${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }}";
  assert.equal(workflow.includes("origin/main...HEAD"), false);
  assert.equal(workflow.split(pullRequestRange).length - 1, 4);
  assert.doesNotMatch(workflow, /name: Branch Flow Policy/);
});

test("reruns PR checks when the pull request base is edited", () => {
  assert.match(
    workflow,
    /pull_request:\n\s+types: \[opened, synchronize, reopened, ready_for_review, edited, labeled, unlabeled\]/,
  );
});

test("runs trusted-base policy for conflicting and edited pull requests", () => {
  assert.ok(policyWorkflow, "Branch Flow Policy workflow missing");
  assert.match(policyWorkflow, /pull_request_target:/);
  assert.match(policyWorkflow, /branches: \[main, dev, release\]/);
  assert.match(
    policyWorkflow,
    /types: \[opened, synchronize, reopened, ready_for_review, edited, labeled, unlabeled\]/,
  );
  assert.match(policyWorkflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(policyWorkflow, /(?:contents|pull-requests|actions|checks): write/);
  assert.match(
    policyWorkflow,
    /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/,
  );
  assert.match(policyWorkflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(policyWorkflow, /persist-credentials: false/);
  assert.doesNotMatch(policyWorkflow, /github\.event\.pull_request\.head\.sha|refs\/pull|github\.sha/);
  assert.match(
    policyWorkflow,
    /BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}\n\s+HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/,
  );
  assert.match(
    policyWorkflow,
    /run: node scripts\/branch-flow-policy\.mjs --base "\$BASE_REF" --head "\$HEAD_REF"/,
  );
  assert.doesNotMatch(
    policyWorkflow,
    /run:[^\n]*\$\{\{[\s\S]*?github\.event\.pull_request\.(?:base|head)\.ref/,
  );
});

test("allows each documented route into permanent branches", () => {
  // Given: representative short-lived and promotion routes.
  const routes = [
    ["dev", "codex/probe"],
    ["dev", "release"],
    ["release", "dev"],
    ["release", "main"],
    ["release", "fix/rc-probe"],
    ["main", "release"],
    ["main", "hotfix/probe"],
  ];

  for (const [base, head] of routes) {
    // When: the policy evaluates the route.
    const result = runPolicy(base, head);

    // Then: it succeeds with an exact, observable decision.
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `Branch flow allowed: ${head} -> ${base}.\n`);
    assert.equal(result.stderr, "");
  }
});

test("leaves non-permanent bases unconstrained for stacked PRs", () => {
  // Given: a stacked PR targeting another feature branch.
  // When: the policy evaluates it.
  const result = runPolicy("feat/parent", "fix/child");

  // Then: it is allowed.
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "Branch flow allowed: fix/child -> feat/parent.\n");
  assert.equal(result.stderr, "");
});

test("rejects an invalid route with the allowed routes", () => {
  // Given: a feature branch targeting main directly.
  // When: the policy evaluates it.
  const result = runPolicy("main", "feat/probe");

  // Then: it fails and explains the permitted route without false success output.
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Branch flow denied: feat/probe -> main. Allowed heads for main: release, hotfix/*.\n",
  );
});

test("rejects empty input deterministically", () => {
  // Given: an empty head branch supplied as an inert argument.
  // When: the policy parses the CLI boundary.
  const result = runPolicy("dev", "");

  // Then: it fails with normalized output.
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Invalid branch flow input: --base and --head must be non-empty branch names.\n",
  );
});
