import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentixdev/benchmark-harness": fileURLToPath(
        new URL("../harness/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["benchmarks/reports/src/**/*.test.ts"],
    environment: "node",
    sequence: { concurrent: false },
  },
});
