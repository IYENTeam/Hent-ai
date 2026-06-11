#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const checks = [
  {
    label: "service focused verifier/worker regression",
    cwd: "service",
    command: "npx",
    args: ["vitest", "run", "src/service.test.ts", "src/verifier.test.ts", "src/generation-worker.test.ts"],
  },
  {
    label: "openclaw full regression suite",
    cwd: "openclaw",
    command: "npx",
    args: ["vitest", "run"],
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
