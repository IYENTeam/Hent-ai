#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const externalAssetRoot = process.env.HENT_AI_ASSET_ROOT?.trim() || resolve(homedir(), ".hent-ai/assets");
const externalAffectSetId = process.env.HENT_AI_AFFECT_SET_ID?.trim() || "gothic-affect-v3";
const arguments_ = process.argv.slice(2);
const listJsonMode = arguments_.length === 1 && arguments_[0] === "--list-json";
const commandPath = process.env.HENT_AI_RELEASE_GATE_COMMAND_PATH ?? process.env.PATH ?? "";

function nodeMajor(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
  return Number(/^v(\d+)/.exec(result.stdout)?.[1]);
}

if (!listJsonMode && Number(process.versions.node.split(".")[0]) !== 22) {
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
  console.error(`[release-gate] re-executing with Node.js 22: ${node22}`);
  const result = spawnSync(node22, [scriptPath, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HENT_AI_RELEASE_GATE_COMMAND_PATH: commandPath,
      PATH: `${dirname(node22)}${delimiter}${commandPath}`,
    },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const liveDiscordEnv = [
  "HENT_AI_DISCORD_POLLER_TOKEN",
  "HENT_AI_DISCORD_POLLER_CHANNELS",
  "HENT_AI_DISCORD_POLLER_LIVE_SEND_CONTENT",
  "DISCORD_BOT_TOKEN",
];

const portableChecks = [
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

const localPreflightChecks = [
  {
    id: "service-owned-boundary",
    label: "service-owned architecture boundary",
    cwd: ".",
    command: "node",
    args: ["scripts/service-owned-boundary-check.mjs"],
  },
  {
    id: "codex-affect-setup",
    label: "Codex affect setup entrypoint",
    cwd: ".",
    command: "node",
    args: ["--test", "scripts/codex-affect-setup.test.mjs"],
  },
];

const localHostChecks = [
  {
    id: "external-affect-corpus",
    label: "external VisualAffectV2 asset corpus",
    cwd: ".",
    command: "node",
    args: ["scripts/verify-affect-assets.mjs", externalAssetRoot, externalAffectSetId],
  },
  {
    id: "local-openclaw-e2e",
    label: "isolated and restored local OpenClaw E2E",
    cwd: ".",
    command: "node",
    args: ["scripts/e2e-hent-openclaw.mjs"],
  },
];

async function resolveCommand(command) {
  if (command === "node") return process.execPath;
  if (command.includes("/")) return command;

  for (const directory of commandPath.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the caller's command path.
    }
  }
  return command;
}

function runCheck(check) {
  return new Promise((resolveCheck) => {
    void resolveCommand(check.command).then((command) => {
      console.log(`\n[release-gate] ${check.label}`);
      const env = { ...process.env };
      for (const key of check.envUnset ?? []) delete env[key];
      const child = spawn(command, check.args, {
        cwd: resolve(root, check.cwd),
        env: { ...env, PATH: `${dirname(process.execPath)}${delimiter}${commandPath}` },
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.on("close", (code) => resolveCheck(code ?? 1));
      child.on("error", (error) => {
        console.error(`[release-gate] failed to start ${check.label}: ${error.message}`);
        resolveCheck(1);
      });
    });
  });
}

if (listJsonMode) {
  console.log(JSON.stringify({
    lanes: portableChecks.map(({ id, label, cwd, command, args, envUnset = [] }) => ({
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

const ciMode = arguments_.length === 1 && arguments_[0] === "--ci";
if (arguments_.length > 0 && !ciMode) {
  console.error(`[release-gate] unknown argument: ${arguments_[0]}`);
  process.exit(2);
}

const checks = ciMode
  ? portableChecks
  : [...localPreflightChecks, ...portableChecks, ...localHostChecks];

for (const check of checks) {
  const code = await runCheck(check);
  if (code !== 0) {
    console.error(`[release-gate] ${check.label} failed with exit code ${code}`);
    console.error("\n[release-gate] failed; release is blocked.");
    process.exit(code);
  }
}

console.log(`\n[release-gate] passed; ${ciMode ? "portable CI" : "local release"} regression gate is clean.`);
