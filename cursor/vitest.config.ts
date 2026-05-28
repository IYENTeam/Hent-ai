import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@hent-ai/shared": resolve(here, "..", "shared", "emotions.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
