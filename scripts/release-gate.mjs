#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const checks = [
  {
    label: "service-owned architecture boundary",
    cwd: ".",
    command: "node",
    args: ["scripts/service-owned-boundary-check.mjs"],
  },
  {
    label: "service focused verifier/poller/worker regression",
    cwd: "service",
    command: "npx",
    args: ["vitest", "run", "src/service.test.ts", "src/verifier.test.ts", "src/discord-rest-poller.test.ts", "src/generation-worker.test.ts"],
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
];

function runCheck(check) {
  return new Promise((resolveCheck) => {
    console.log(`\n[release-gate] ${check.label}`);
    const child = spawn(check.command, check.args, {
      cwd: resolve(root, check.cwd),
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
