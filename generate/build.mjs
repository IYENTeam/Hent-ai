import { execFileSync } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const output = resolve(root, process.argv[2] ?? "dist");
const require = createRequire(import.meta.url);

// Ship the shared JS graph inside dist, preserving its relative imports. Stable
// public entrypoints keep consumers independent of the compiler's source layout.
await rm(output, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", resolve(root, "tsconfig.json"), "--outDir", output], { cwd: root, stdio: "inherit" });
await writeFile(resolve(output, "main.js"), '#!/usr/bin/env node\nimport "./generate/src/main.js";\n');
await writeFile(resolve(output, "index.js"), 'export * from "./generate/src/index.js";\n');
await writeFile(resolve(output, "index.d.ts"), 'export * from "./generate/src/index.js";\n');
await chmod(resolve(output, "main.js"), 0o755);
