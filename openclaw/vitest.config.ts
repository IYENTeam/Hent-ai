import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": resolve(here, "test/stubs/plugin-entry.ts"),
      "@hent-ai/generate": resolve(here, "..", "generate", "src", "index.ts"),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
  },
});
