import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the built package outside the source tree with plain Node and only production dependencies", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const consumer = mkdtempSync(join(tmpdir(), "hent-package-consumer-"));
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    writeFileSync(join(consumer, "package.json"), JSON.stringify(manifest));
    execFileSync(process.execPath, [join(root, "build.mjs"), join(consumer, "dist")], { cwd: root, stdio: "pipe" });
    mkdirSync(join(consumer, "node_modules"));
    for (const name of Object.keys(manifest.dependencies)) {
      expect(name).not.toBe("@hent-ai/shared");
      const target = join(consumer, "node_modules", name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(realpathSync(join(root, "node_modules", name)), target, "dir");
    }
    const cli = resolve(consumer, manifest.bin["hent-ai"]);
    expect(execFileSync(process.execPath, [cli, "--help"], { cwd: consumer, encoding: "utf8" })).toContain("Usage:");
    expect(execFileSync(process.execPath, [cli, "--version"], { cwd: consumer, encoding: "utf8" }).trim()).toBe(manifest.version);
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", 'const library = await import("./dist/index.js"); console.log(typeof library.generateAllEmotions);'], { cwd: consumer, encoding: "utf8" }).trim()).toBe("function");
  } finally { rmSync(consumer, { recursive: true, force: true }); }
}, 20_000);
