import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = join(checkoutRoot, "service/node_modules/tsx/dist/loader.mjs");
const driver = join(checkoutRoot, "tests/e2e/openclaw-child.ts");

if (!existsSync(tsxLoader)) throw new Error(`tsx loader not found: ${tsxLoader}`);
if (!existsSync(driver)) throw new Error(`E2E driver not found: ${driver}`);

const child = spawn(process.execPath, ["--import", tsxLoader, driver], {
  cwd: checkoutRoot,
  env: { ...process.env },
  stdio: "inherit",
});

const exitCode = await new Promise((resolveCode, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) return reject(new Error(`E2E driver terminated by ${signal}`));
    resolveCode(code ?? 1);
  });
});

if (exitCode !== 0) process.exitCode = exitCode;
