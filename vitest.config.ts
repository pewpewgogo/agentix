import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@agentixdev/core": fromRoot("./packages/core/src/index.ts"),
      "@agentixdev/testing": fromRoot("./packages/testing/src/index.ts"),
      "@agentixdev/compiler": fromRoot("./packages/compiler/src/index.ts"),
      "@agentixdev/adapters-http": fromRoot(
        "./packages/adapters-http/src/index.ts",
      ),
      "@agentixdev/shared-contract/acceptance": fromRoot(
        "./examples/shared-contract/src/acceptance.ts",
      ),
      "@agentixdev/shared-contract": fromRoot(
        "./examples/shared-contract/src/index.ts",
      ),
      "@agentixdev/framework-app": fromRoot(
        "./examples/framework-app/src/index.ts",
      ),
      "@agentixdev/plain-app": fromRoot("./examples/plain-app/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "examples/**/*.test.ts",
      "benchmarks/**/*.test.ts",
      "sandbox/**/*.test.ts"
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "packages/**/test/fixtures/**",
      "benchmarks/fixtures/**"
    ],
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    sequence: {
      concurrent: false
    }
  }
});
