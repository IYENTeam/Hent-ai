#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const externalAssetRoot = process.env.HENT_AI_ASSET_ROOT?.trim() || resolve(homedir(), ".hent-ai/assets");
const externalAffectSetId = process.env.HENT_AI_AFFECT_SET_ID?.trim() || "gothic-affect-v3";

function nodeMajor(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
  return Number(/^v(\d+)/.exec(result.stdout)?.[1]);
}

if (Number(process.versions.node.split(".")[0]) !== 22) {
  const candidates = [
    process.env.HENT_AI_NODE22,
    "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/opt/node@22/bin/node",
  ].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);
  const node22 = candidates.find((candidate) => existsSync(candidate) && nodeMajor(candidate) === 22);
  if (!node22) {
    console.error(`[release-gate] Node.js 22 is required (current: ${process.version}). Set HENT_AI_NODE22 to a Node.js 22 executable.`);
    process.exit(1);
  }
  console.log(`[release-gate] re-executing with Node.js 22: ${node22}`);
  const result = spawnSync(node22, [scriptPath, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${dirname(node22)}${delimiter}${process.env.PATH ?? ""}` },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const checks = [
  {
    label: "service-owned architecture boundary",
    cwd: ".",
    command: "node",
    args: ["scripts/service-owned-boundary-check.mjs"],
  },
  {
    label: "Codex affect setup entrypoint",
    cwd: ".",
    command: "node",
    args: ["--test", "scripts/codex-affect-setup.test.mjs"],
  },
  {
    label: "service focused verifier/poller/worker regression",
    cwd: "service",
    command: "npx",
    args: ["vitest", "run", "src/service.test.ts", "src/verifier.test.ts", "src/final-response-media-sanitizer.test.ts", "src/discord-rest-poller.test.ts", "src/generation-worker.test.ts"],
  },
  {
    label: "adaptive ambient participant regression",
    cwd: "service",
    command: "npx",
    args: ["vitest", "run", "src/adaptive-ambient-contracts.test.ts", "src/adaptive-ambient-provider.test.ts", "src/adaptive-ambient-runtime.test.ts", "src/adaptive-ambient-store.test.ts", "src/conversation-archive-scheduler.test.ts", "src/conversation-relationship-profile.test.ts", "src/discord-participant-client.test.ts", "src/discord-ambient-worker-core.test.ts", "src/discord-ambient-delivery.test.ts", "src/discord-ambient-worker.test.ts", "src/discord-ambient-worker.wire.test.ts", "src/discord-ambient-worker.live.test.ts", "src/adaptive-ambient-review-regressions.test.ts", "src/adaptive-ambient.redteam.test.ts", "src/conversation-ambient.test.ts", "src/discord-ambient-worker.redteam.test.ts"],
  },
  {
    label: "shared emotion contract",
    cwd: "shared",
    command: "npx",
    args: ["vitest", "run"],
  },
  {
    label: "generate asset manifest regression",
    cwd: "generate",
    command: "npx",
    args: ["vitest", "run", "src/sets.test.ts"],
  },
  {
    label: "external VisualAffectV2 asset corpus",
    cwd: ".",
    command: "node",
    args: ["scripts/verify-affect-assets.mjs", externalAssetRoot, externalAffectSetId],
  },
  {
    label: "Hermes compatibility parity",
    cwd: ".",
    command: "python3",
    args: ["-m", "unittest", "discover", "-s", "tests/hermes"],
  },
  {
    label: "openclaw full regression suite",
    cwd: "openclaw",
    command: "npx",
    args: ["vitest", "run"],
  },
  {
    label: "openclaw typecheck",
    cwd: "openclaw",
    command: "npx",
    args: ["tsc", "--noEmit"],
  },
  {
    label: "service typecheck",
    cwd: "service",
    command: "npx",
    args: ["tsc", "--noEmit"],
  },
  {
    label: "generate typecheck",
    cwd: "generate",
    command: "npx",
    args: ["tsc", "--noEmit"],
  },
  {
    label: "isolated and restored local OpenClaw E2E",
    cwd: ".",
    command: "node",
    args: ["scripts/e2e-hent-openclaw.mjs"],
  },
];

function runCheck(check) {
  return new Promise((resolveCheck) => {
    console.log(`\n[release-gate] ${check.label}`);
    const child = spawn(check.command, check.args, {
      cwd: resolve(root, check.cwd),
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("close", (code) => resolveCheck(code ?? 1));
    child.on("error", (error) => {
      console.error(`[release-gate] failed to start ${check.label}: ${error.message}`);
      resolveCheck(1);
    });
  });
}

let failed = false;
for (const check of checks) {
  const code = await runCheck(check);
  if (code !== 0) {
    console.error(`[release-gate] ${check.label} failed with exit code ${code}`);
    failed = true;
  }
}

if (failed) {
  console.error("\n[release-gate] failed; release is blocked.");
  process.exit(1);
}

console.log("\n[release-gate] passed; local release regression gate is clean.");
