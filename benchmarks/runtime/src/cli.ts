#!/usr/bin/env node
import { resolve } from "node:path";

import { runRuntimeBenchmark } from "./benchmark.js";
import { publishRuntimeReport } from "./result-store.js";

const rawArguments = process.argv.slice(2);
const arguments_ = new Set(rawArguments);
const valueArgument = (names: readonly string[]): string | undefined => {
  const matches = rawArguments.filter((value) =>
    names.some((name) => value.startsWith(`${name}=`))
  );
  if (matches.length > 1) throw new TypeError(`Specify only one of ${names.join(", ")}.`);
  const match = matches[0];
  if (match === undefined) return undefined;
  const value = match.slice(match.indexOf("=") + 1);
  if (value.length === 0) throw new TypeError(`${match.slice(0, match.indexOf("="))} cannot be empty.`);
  return value;
};
for (const argument of rawArguments) {
  if (["--smoke", "--confirmatory-runtime", "--no-process", "--toolchain"].includes(argument)) {
    continue;
  }
  if (["--root=", "--output-dir=", "--output="].some((prefix) => argument.startsWith(prefix))) {
    continue;
  }
  throw new TypeError(`Unknown runtime benchmark argument: ${argument}`);
}
if (arguments_.has("--smoke") && arguments_.has("--confirmatory-runtime")) {
  throw new TypeError("Choose either --smoke or --confirmatory-runtime.");
}
const mode = arguments_.has("--confirmatory-runtime") ? "confirmatory" : "smoke";
const rootArgument = valueArgument(["--root"]);
const outputArgument = valueArgument(["--output-dir", "--output"]);
if (mode === "confirmatory" && outputArgument === undefined) {
  throw new TypeError("Confirmatory runtime measurement requires --output-dir for sealed evidence.");
}
if (mode === "confirmatory" && arguments_.has("--no-process")) {
  throw new TypeError("Confirmatory runtime measurement cannot disable process metrics.");
}
const repositoryRoot = resolve(rootArgument ?? process.cwd());
const report = await runRuntimeBenchmark({
  repositoryRoot,
  mode,
  seed: "runtime-preregistered-v2",
  warmupIterations: mode === "smoke" ? 1 : 10,
  measuredIterations: mode === "smoke" ? 3 : 30,
  includeProcessMetrics: mode === "confirmatory" || !arguments_.has("--no-process"),
  includeToolchainMetrics: mode === "confirmatory" || arguments_.has("--toolchain"),
  toolchainIterations: mode === "smoke" ? 1 : 10,
});
if (outputArgument === undefined) {
  // Unsealed stdout is intentionally limited to smoke diagnostics.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const publication = await publishRuntimeReport({
    resultsRoot: resolve(outputArgument),
    report,
  });
  process.stdout.write(`${JSON.stringify({
    kind: "runtime-publication-pointer",
    ...publication,
  }, null, 2)}\n`);
  if (mode === "confirmatory" && !publication.eligibleForConfirmatoryUse) {
    process.exitCode = 2;
  }
}
