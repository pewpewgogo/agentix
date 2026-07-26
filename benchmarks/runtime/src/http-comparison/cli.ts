#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_HTTP_COMPARISON_SEED,
  runHttpFrameworkComparison,
} from "./benchmark.js";

const HELP = `Exploratory Agentix/Express/NestJS HTTP comparison (methodology v2).

Usage:
  node benchmarks/runtime/dist/http-comparison/cli.js [options]

Options:
  --isolated              Run every target in its own child process and measure
                          over real loopback sockets. RECOMMENDED: the default
                          in-process mode keeps all servers and the measuring
                          client on ONE event loop, which inflated the v1
                          cross-stack gap roughly tenfold. The default stays
                          in-process only for continuity with v1 records.
  --root=<dir>            Repository root (default: current directory).
  --seed=<seed>           Schedule seed (default: ${DEFAULT_HTTP_COMPARISON_SEED}).
  --warmups=<n>           Warmup iterations per workload (default: 10).
  --measured=<n>          Measured iterations per workload (default: 100).
  --process-iterations=<n> Fresh-process probe iterations (default: 5).
  --no-process            Skip fresh-process cold-ready/RSS probes.
  --output=<file>         Write the JSON report create-only (never overwrite);
                          otherwise the report prints to stdout. NEVER write
                          into benchmarks/results/ unless publishing a real run.
  --help                  Show this help.
`;

const rawArguments = process.argv.slice(2);

if (rawArguments.includes("--help") || rawArguments.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

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
  if (argument === "--no-process" || argument === "--isolated") continue;
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
  seed: option("--seed") ?? DEFAULT_HTTP_COMPARISON_SEED,
  warmupIterations: integerOption("--warmups") ?? 10,
  measuredIterations: integerOption("--measured") ?? 100,
  processIterations: integerOption("--process-iterations") ?? 5,
  includeProcessMetrics: !rawArguments.includes("--no-process"),
  isolated: rawArguments.includes("--isolated"),
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
    schemaVersion: 2,
    path: outputPath,
    processIsolation: report.methodology.processIsolation,
    measurementPlanSha256: report.measurementPlanSha256,
    comparisonSourceSha256: report.repository.comparisonSourceSha256,
    eligibleForConfirmatoryUse: false,
  })}\n`);
}
