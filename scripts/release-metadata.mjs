#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseVersionPattern = /^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;
const commitShaPattern = /^[0-9a-f]{40}$/;

export class ReleaseMetadataError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseMetadataError";
  }
}

export function parseReleaseVersion(value) {
  if (!releaseVersionPattern.test(value)) {
    throw new ReleaseMetadataError("version must match YYYY.M.PATCH");
  }
  return value;
}

export function buildReleasePlan(input) {
  const version = parseReleaseVersion(input.version);
  if (version !== input.packageVersion) {
    throw new ReleaseMetadataError(`version ${version} does not equal openclaw package version ${input.packageVersion}`);
  }
  if (!commitShaPattern.test(input.targetSha) || !commitShaPattern.test(input.mainSha)) {
    throw new ReleaseMetadataError("target and main SHA must be full lowercase commit SHAs");
  }
  if (input.targetSha !== input.mainSha) {
    throw new ReleaseMetadataError(`target SHA ${input.targetSha} is not current main ${input.mainSha}`);
  }

  const tag = `v${version}`;
  if (input.tagSha === undefined) {
    return { version, tag, targetSha: input.targetSha, action: "create", dryRun: input.dryRun };
  }
  if (input.tagSha !== input.targetSha) {
    throw new ReleaseMetadataError(`tag ${tag} already points to different SHA ${input.tagSha}`);
  }
  return {
    version,
    tag,
    targetSha: input.targetSha,
    action: input.releaseExists ? "noop" : "resume",
    dryRun: input.dryRun,
  };
}

function parseArguments(argv) {
  const values = new Map();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (dryRun) throw new ReleaseMetadataError("duplicate argument: --dry-run");
      dryRun = true;
      continue;
    }
    if (!["--version", "--target-sha", "--main-ref"].includes(argument)) {
      throw new ReleaseMetadataError(`unknown argument: ${argument}`);
    }
    if (values.has(argument)) throw new ReleaseMetadataError(`duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ReleaseMetadataError(`missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  return {
    version: values.get("--version") ?? "",
    targetSha: values.get("--target-sha") ?? "",
    mainRef: values.get("--main-ref") ?? "refs/heads/main",
    dryRun,
  };
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new ReleaseMetadataError(`${command} failed to start: ${result.error.message}`);
  return result;
}

function gitValue(root, args, missingAllowed = false) {
  const result = run("git", args, { cwd: root });
  if (result.status === 0) return result.stdout.trim();
  if (missingAllowed && result.status === 1) return undefined;
  throw new ReleaseMetadataError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
}

function githubReleaseExists(root, repository, tag) {
  if (!repository) {
    throw new ReleaseMetadataError("GITHUB_REPOSITORY is required to inspect an existing tag's release");
  }
  const result = run("gh", ["api", `repos/${repository}/releases/tags/${tag}`, "--silent"], { cwd: root });
  if (result.status === 0) return true;
  if (result.status === 1 && result.stderr.includes("HTTP 404")) return false;
  throw new ReleaseMetadataError(`GitHub release lookup failed: ${result.stderr.trim()}`);
}

export async function inspectRelease(argv, options = {}) {
  const root = options.root ?? defaultRoot;
  const args = parseArguments(argv);
  const packageJson = JSON.parse(await readFile(resolve(root, "openclaw/package.json"), "utf8"));
  const version = parseReleaseVersion(args.version);
  const tag = `v${version}`;
  const mainSha = gitValue(root, ["rev-parse", "--verify", `${args.mainRef}^{commit}`]);
  const tagSha = gitValue(root, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], true);
  const plan = buildReleasePlan({
    version,
    packageVersion: packageJson.version,
    targetSha: args.targetSha,
    mainSha,
    tagSha,
    releaseExists: false,
    dryRun: args.dryRun,
  });
  if (plan.action !== "resume") return plan;

  const releaseExists = options.releaseExists
    ? await options.releaseExists(tag)
    : githubReleaseExists(root, options.repository ?? process.env.GITHUB_REPOSITORY, tag);
  return { ...plan, action: releaseExists ? "noop" : "resume" };
}

async function main() {
  try {
    const plan = await inspectRelease(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } catch (error) {
    if (error instanceof ReleaseMetadataError || error instanceof SyntaxError) {
      console.error(`[release-metadata] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
