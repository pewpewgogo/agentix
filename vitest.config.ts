import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@agentix/core": fromRoot("./packages/core/src/index.ts"),
      "@agentix/testing": fromRoot("./packages/testing/src/index.ts"),
      "@agentix/compiler": fromRoot("./packages/compiler/src/index.ts"),
      "@agentix/adapters-http": fromRoot(
        "./packages/adapters-http/src/index.ts",
      ),
      "@agentix/shared-contract/acceptance": fromRoot(
        "./examples/shared-contract/src/acceptance.ts",
      ),
      "@agentix/shared-contract": fromRoot(
        "./examples/shared-contract/src/index.ts",
      ),
      "@agentix/framework-app": fromRoot(
        "./examples/framework-app/src/index.ts",
      ),
      "@agentix/plain-app": fromRoot("./examples/plain-app/src/index.ts"),
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
      "packages/**/test/_v1/**",
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
