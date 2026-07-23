#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runHttpFrameworkComparison } from "./benchmark.js";

const rawArguments = process.argv.slice(2);

const option = (name: string): string | undefined => {
  const matches = rawArguments.filter((value) => value.startsWith(`${name}=`));
  if (matches.length > 1) throw new TypeError(`Specify ${name} only once.`);
  const match = matches[0];
  if (match === undefined) return undefined;
  const value = match.slice(name.length + 1);
  if (value.length === 0) throw new TypeError(`${name} cannot be empty.`);
  return value;
};

for (const argument of rawArguments) {
  if (argument === "--no-process") continue;
  if ([
    "--root=",
    "--seed=",
    "--warmups=",
    "--measured=",
    "--process-iterations=",
    "--output=",
  ].some((prefix) => argument.startsWith(prefix))) continue;
  throw new TypeError(`Unknown HTTP comparison argument: ${argument}`);
}

const integerOption = (name: string): number | undefined => {
  const value = option(name);
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new TypeError(`${name} must be an integer.`);
  return Number(value);
};

const output = option("--output");
const report = await runHttpFrameworkComparison({
  repositoryRoot: resolve(option("--root") ?? process.cwd()),
  seed: option("--seed") ?? "agentix-http-frameworks-exploratory-v1-2026-07-23",
  warmupIterations: integerOption("--warmups") ?? 10,
  measuredIterations: integerOption("--measured") ?? 100,
  processIterations: integerOption("--process-iterations") ?? 5,
  includeProcessMetrics: !rawArguments.includes("--no-process"),
});
const json = `${JSON.stringify(report, null, 2)}\n`;

if (output === undefined) {
  process.stdout.write(json);
} else {
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json, { encoding: "utf8", flag: "wx", mode: 0o444 });
  process.stdout.write(`${JSON.stringify({
    kind: "agentix-http-framework-comparison-pointer",
    path: outputPath,
    measurementPlanSha256: report.measurementPlanSha256,
    comparisonSourceSha256: report.repository.comparisonSourceSha256,
    eligibleForConfirmatoryUse: false,
  })}\n`);
}
