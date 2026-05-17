import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": resolve(here, "test/stubs/plugin-entry.ts"),
      "@hent-ai/generate": resolve(here, "test", "stubs", "generate.ts"),
      "@hent-ai/shared": resolve(here, "..", "shared", "emotions.ts"),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["onboarding/parsers.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
