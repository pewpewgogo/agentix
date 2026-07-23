import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { stableJson } from "./files.js";
import { analyzeProject } from "./scanner.js";
import type { GenerateOptions, GeneratedIndex } from "./types.js";

export const generateIndex = (options: GenerateOptions): GeneratedIndex => {
  const index = analyzeProject(options);
  const json = stableJson(index);
  const outputFile = resolve(options.rootDir, options.outputFile ?? ".agentix/index.json");
  if (options.write === true) {
    mkdirSync(dirname(outputFile), { recursive: true });
    const temporary = `${outputFile}.tmp-${process.pid}`;
    writeFileSync(temporary, json, "utf8");
    renameSync(temporary, outputFile);
  }
  return { index, json, outputFile };
};
