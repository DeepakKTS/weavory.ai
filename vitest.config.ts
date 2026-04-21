import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "coverage",
    },
    // Reporters chosen so the dashboard collector can read a JSON file too.
    // We keep `default` for human output; the `collect:tests` script copies
    // the JSON reporter output into ops/data/tests.json.
    reporters: ["default"],
  },
});
