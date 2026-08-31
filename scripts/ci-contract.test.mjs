import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const workflowFiles = [
  "branch-flow-policy.yml",
  "ci.yml",
  "pr-checks.yml",
  "release.yml",
];

function job(jobId) {
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9_]*):\s*$/gm)];
  const matchIndex = jobs.findIndex((match) => match[1] === jobId);
  assert.notEqual(matchIndex, -1, `missing workflow job: ${jobId}`);
  const start = jobs[matchIndex].index;
  const end = jobs[matchIndex + 1]?.index ?? workflow.length;
  return workflow.slice(start, end);
}

function branches(eventName) {
  const match = workflow.match(
    new RegExp(`^  ${eventName}:\\n    branches: \\[([^\\]]+)\\]`, "m"),
  );
  assert.ok(match, `missing inline branch list for ${eventName}`);
  return match[1].split(",").map((branch) => branch.trim());
}

function needs(jobText) {
  const match = jobText.match(/^    needs: \[([^\]]+)\]$/m);
  assert.ok(match, "job must use an explicit inline needs list");
  return match[1].split(",").map((jobId) => jobId.trim());
}

function assertNamed(jobId, name) {
  assert.match(job(jobId), new RegExp(`^    name: ${name}$`, "m"));
}

test("preserves the existing package lanes and integration contract checks", () => {
  assertNamed("openclaw", "OpenClaw Plugin");
  assertNamed("generate", "Generate Module");
  assertNamed("hermes", "Hermes Plugin \\(Python\\)");
  assertNamed("integration", "Integration Check");

  const integration = job("integration");
  assert.match(integration, /name: Verify plugin manifest/);
  assert.match(integration, /openclaw\/openclaw\.plugin\.json/);
  assert.match(integration, /name: Verify assets integrity/);
  assert.match(integration, /ASSET_DIR="assets"/);
  assert.match(integration, /name: Verify entry point exports/);
  assert.match(integration, /openclaw\/index\.ts/);
  assert.match(integration, /definePluginEntry/);
});

test("runs push and pull-request CI on main, dev, and release", () => {
  assert.deepEqual(branches("push"), ["main", "dev", "release"]);
  assert.deepEqual(branches("pull_request"), ["main", "dev", "release"]);
  assert.match(
    workflow,
    /pull_request:\n\s+branches: \[main, dev, release\]\n\s+types: \[opened, synchronize, reopened, ready_for_review, edited\]/,
  );
});

test("makes TypeScript and tests blocking across runtime/package lanes", () => {
  const openclaw = job("openclaw");
  assert.match(openclaw, /name: Type check[\s\S]*pnpm exec tsc --noEmit --skipLibCheck/);
  assert.doesNotMatch(openclaw, /TypeScript check skipped|name: Lint|name: Test coverage/);

  const service = job("service");
  assertNamed("service", "Service");
  assert.match(service, /working-directory: service/);
  assert.match(service, /run: npm ci/);
  assert.match(service, /name: Type check[\s\S]*run: npx tsc --noEmit/);
  assert.match(service, /name: Test[\s\S]*run: npm test/);
  assert.doesNotMatch(service, /continue-on-error|\|\| echo/);

  const shared = job("shared");
  assertNamed("shared", "Shared");
  assert.match(shared, /working-directory: shared/);
  assert.match(shared, /run: npm ci/);
  assert.match(shared, /name: Test[\s\S]*run: npm test/);
});

test("uses Python stdlib unittest for the Hermes lane", () => {
  const hermes = job("hermes");
  assert.match(
    hermes,
    /python -m unittest discover -s tests\/hermes -p ['"]test_\*\.py['"] -v/,
  );
  assert.doesNotMatch(hermes, /pytest|pip install/);
});

test("integration waits for every runtime and package lane", () => {
  assert.deepEqual(needs(job("integration")), [
    "openclaw",
    "generate",
    "service",
    "shared",
    "hermes",
  ]);
});

test("defines stable, fail-closed aggregate checks", () => {
  const ciRequired = job("ci_required");
  assertNamed("ci_required", "CI Required");
  assert.match(ciRequired, /^    if: always\(\)$/m);
  assert.deepEqual(needs(ciRequired), [
    "openclaw",
    "generate",
    "service",
    "shared",
    "hermes",
    "integration",
  ]);
  assert.match(ciRequired, /Object\.entries\(needs\)/);
  assert.match(ciRequired, /result !== "success"/);
  assert.match(ciRequired, /process\.exit\(1\)/);

  const releaseGate = job("release_gate");
  assertNamed("release_gate", "Release Gate");
  assert.equal((workflow.match(/^    name: Release Gate$/gm) ?? []).length, 1);
  assert.deepEqual(needs(releaseGate), ["ci_required"]);
  assert.match(releaseGate, /always\(\)/);
  assert.match(releaseGate, /github\.event_name == 'push'/);
  assert.match(releaseGate, /github\.event_name == 'pull_request'/);
  assert.match(releaseGate, /github\.ref_name == 'main'/);
  assert.match(releaseGate, /github\.ref_name == 'release'/);
  assert.match(releaseGate, /github\.base_ref == 'main'/);
  assert.match(releaseGate, /github\.base_ref == 'release'/);
  assert.match(releaseGate, /needs\.ci_required\.result[^\n]+!= ["']success["']/);
  assert.match(releaseGate, /exit 1/);
});

test("pins every external GitHub Action to a full commit SHA", () => {
  for (const filename of workflowFiles) {
    const contents = readFileSync(
      resolve(root, ".github/workflows", filename),
      "utf8",
    );
    const references = [...contents.matchAll(/^\s*uses:\s+([^\s#]+)/gm)].map(
      (match) => match[1],
    );

    assert.ok(references.length > 0, `${filename} must use at least one action`);
    for (const reference of references) {
      if (reference.startsWith("./")) continue;
      assert.match(
        reference,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${filename} contains an unpinned action: ${reference}`,
      );
    }
  }
});
