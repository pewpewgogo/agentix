import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createSourceManifest, discoverSourceFiles } from "./files.js";
import {
  COMPILER_VERSION,
  INDEX_SCHEMA_VERSION,
  type AgentIndex,
} from "./types.js";

export interface StalenessResult {
  readonly stale: boolean;
  readonly reason?: string;
}

export const checkIndexStaleness = (
  index: AgentIndex,
  rootDir: string,
  files?: readonly string[],
): StalenessResult => {
  if (
    index.schemaVersion !== INDEX_SCHEMA_VERSION ||
    index.compilerVersion !== COMPILER_VERSION
  ) {
    return {
      stale: true,
      reason: "The generated index uses an incompatible schema or compiler version.",
    };
  }
  const manifest = createSourceManifest(
    rootDir,
    discoverSourceFiles(rootDir, files),
  );
  if (manifest.digest !== index.sourceManifest.digest) {
    return {
      stale: true,
      reason: "The deterministic source manifest differs from the generated index.",
    };
  }
  return { stale: false };
};

export const readIndex = (rootDir: string, path = ".agentix/index.json"): AgentIndex => {
  const absolute = resolve(rootDir, path);
  if (!existsSync(absolute)) {
    throw new Error(`Agent index does not exist: ${absolute}`);
  }
  return JSON.parse(readFileSync(absolute, "utf8")) as AgentIndex;
};
