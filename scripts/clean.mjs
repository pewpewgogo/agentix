import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { glob } from "node:fs/promises";

const root = process.cwd();
const removablePatterns = [
  "packages/*/dist",
  "examples/*/dist",
  "benchmarks/*/dist",
  "coverage",
  ".agentix-tmp",
];

for (const pattern of removablePatterns) {
  for await (const relativePath of glob(pattern)) {
    const target = resolve(root, relativePath);
    if (!target.startsWith(`${root}/`)) {
      throw new Error(`Refusing to clean path outside repository: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}
