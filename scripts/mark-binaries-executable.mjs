import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

const defaultTargets = [
  "packages/cli/dist/bin.js",
  "benchmarks/reports/dist/cli.js",
  "benchmarks/runtime/dist/cli.js",
];

const targets = process.argv.slice(2);

for (const relativePath of targets.length > 0 ? targets : defaultTargets) {
  const target = resolve(process.cwd(), relativePath);
  await chmod(target, 0o755);
}
