#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const liveDiscordEnv = [
  "HENT_AI_DISCORD_POLLER_TOKEN",
  "HENT_AI_DISCORD_POLLER_CHANNELS",
  "HENT_AI_DISCORD_POLLER_LIVE_SEND_CONTENT",
  "DISCORD_BOT_TOKEN",
];

const checks = [
  {
    id: "service-typescript",
    label: "service TypeScript",
    cwd: "service",
    command: "npx",
    args: ["tsc", "--noEmit"],
    envUnset: liveDiscordEnv,
  },
  {
    id: "service-tests",
    label: "service full regression suite",
    cwd: "service",
    command: "npx",
    args: ["vitest", "run"],
    envUnset: liveDiscordEnv,
  },
  {
    id: "openclaw-typescript",
    label: "openclaw TypeScript",
    cwd: "openclaw",
    command: "npx",
    args: ["tsc", "--noEmit"],
  },
  {
    id: "openclaw-tests",
    label: "openclaw full regression suite",
    cwd: "openclaw",
    command: "npx",
    args: ["vitest", "run"],
  },
  {
    id: "generate-build",
    label: "generate build",
    cwd: "generate",
    command: "npm",
    args: ["run", "build"],
  },
  {
    id: "generate-tests",
    label: "generate full regression suite",
    cwd: "generate",
    command: "npx",
    args: ["vitest", "run"],
  },
  {
    id: "shared-tests",
    label: "shared full regression suite",
    cwd: "shared",
    command: "npx",
    args: ["vitest", "run"],
  },
  {
    id: "hermes-unittest",
    label: "Hermes unittest discovery",
    cwd: ".",
    command: "python3",
    args: ["-m", "unittest", "discover", "-s", "tests/hermes", "-p", "test_*.py"],
  },
  {
    id: "static-contracts",
    label: "static manifest/assets/entrypoint contracts",
    cwd: ".",
    command: "node",
    args: [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
       import { access, readFile } from "node:fs/promises";
       const manifest = JSON.parse(await readFile("assets/manifest.json", "utf8"));
       const plugin = JSON.parse(await readFile("openclaw/openclaw.plugin.json", "utf8"));
       const packageJson = JSON.parse(await readFile("openclaw/package.json", "utf8"));
       const entrypoint = await readFile("openclaw/index.ts", "utf8");
       const emotions = ["sorry", "happy", "confused", "focused", "loyalty", "neutral"];
       assert.ok(manifest.sets[manifest.activeSet], "active asset set is missing");
       for (const [setId, set] of Object.entries(manifest.sets)) {
         assert.deepEqual(Object.keys(set.emotions).sort(), [...emotions].sort(), setId + " emotion contract mismatch");
         for (const emotion of emotions) {
           for (const filename of set.emotions[emotion]) await access("assets/sets/" + setId + "/" + filename);
         }
       }
       assert.equal(plugin.id, "hent-ai-service-adapter");
       assert.equal(packageJson.main, "./index.ts");
       assert.ok(packageJson.files.includes("index.ts"));
       assert.match(entrypoint, /definePluginEntry/);`,
    ],
  },
];

function runCheck(check) {
  return new Promise((resolveCheck) => {
    console.log(`\n[release-gate] ${check.label}`);
    const env = { ...process.env };
    for (const key of check.envUnset ?? []) delete env[key];
    const child = spawn(check.command, check.args, {
      cwd: resolve(root, check.cwd),
      env,
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

const arguments_ = process.argv.slice(2);

if (arguments_.length === 1 && arguments_[0] === "--list-json") {
  console.log(JSON.stringify({
    lanes: checks.map(({ id, label, cwd, command, args, envUnset = [] }) => ({
      id,
      label,
      cwd,
      command,
      args,
      envUnset,
    })),
  }));
  process.exit(0);
}

if (arguments_.length > 0) {
  console.error(`[release-gate] unknown argument: ${arguments_[0]}`);
  process.exit(2);
}

for (const check of checks) {
  const code = await runCheck(check);
  if (code !== 0) {
    console.error(`[release-gate] ${check.label} failed with exit code ${code}`);
    console.error("\n[release-gate] failed; release is blocked.");
    process.exit(code);
  }
}

console.log("\n[release-gate] passed; local release regression gate is clean.");
