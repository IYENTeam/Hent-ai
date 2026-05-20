import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": resolve(here, "test/stubs/plugin-entry.ts"),
      "@hent-ai/generate": resolve(here, "test", "stubs", "generate.ts"),
      "@hent-ai/shared/profile": resolve(here, "..", "shared", "profile.ts"),
      "@hent-ai/shared/db": resolve(here, "..", "shared", "db.ts"),
      "@hent-ai/shared": resolve(here, "..", "shared", "emotions.ts"),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        external: [/better-sqlite3/],
        inline: [],
      },
    },
    coverage: {
      provider: "v8",
      include: [
        "index.ts",
        "discord-utils.ts",
        "assets/channel-overrides.ts",
        "assets/manifest.ts",
        "onboarding/parsers.ts",
        "onboarding/flow.ts",
        "onboarding/index.ts",
        "onboarding/session.ts",
        "onboarding/prompts.ts",
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
