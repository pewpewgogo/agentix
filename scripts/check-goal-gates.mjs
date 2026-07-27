#!/usr/bin/env node
// Regression gates for the framework's two headline claims.
//
// Usage:
//   node scripts/check-goal-gates.mjs token   # deterministic context-cost gate
//   node scripts/check-goal-gates.mjs perf    # flake-resistant performance gate
//
// Prerequisites: npm ci && npm run build (both gates read built dist output).
//
// Every threshold can be overridden through a GOAL_GATE_* environment
// variable. That override path exists so the gate itself can be tested: a
// synthetic violation (for example GOAL_GATE_AFFECTED_TOKENS_MAX=1) must make
// the script exit non-zero.
//
//   Token gate:
//     GOAL_GATE_FULL_SRC_RATIO_MAX      default 1     agentix full-src est. tokens <= express * ratio
//     GOAL_GATE_WRITE_FILE_COUNT_MAX    default 2     agentix change-cost WRITE file count
//     GOAL_GATE_READ_DIRECT_RATIO_MAX   default 1     agentix change-cost READ (direct) est. tokens <= express * ratio
//     GOAL_GATE_AFFECTED_TOKENS_MAX     default 200   agentix `affected` output est. tokens
//
//   Perf gate (generous margins: it catches order-of-magnitude regressions,
//   not noise; each measurement runs twice and the better run is judged):
//     GOAL_GATE_DISPATCH_MEAN_US_MAX    default 5     framework command-dispatch mean (steady state; actual ~1us)
//     GOAL_GATE_ECHO_MEDIAN_RATIO_MAX   default 1.25  agentix / express echo-valid median, in-process, default condition
//     GOAL_GATE_DISPATCH_WARMUPS        default 100   in-process dispatch warmup iterations
//     GOAL_GATE_DISPATCH_MEASURED       default 60    in-process dispatch measured iterations
//     GOAL_GATE_HTTP_WARMUPS            default 20    http-comparison warmup blocks per stack
//     GOAL_GATE_HTTP_MEASURED           default 60    http-comparison measured blocks per stack
//     GOAL_GATE_PERF_RUNS               default 2     independent runs; the best one is judged

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

const numberOverride = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return { value: fallback, overridden: false };
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got: ${raw}`);
  }
  return { value, overridden: true };
};

const log = (message) => process.stderr.write(`${message}\n`);

const runNode = async (scriptArguments) => {
  log(`  $ node ${scriptArguments.join(" ")}`);
  return execFileAsync(process.execPath, scriptArguments, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
};

// One row per assertion. `actual` and `limit` are display strings; `ok` is the
// verdict; `detail` explains where the numbers came from.
const renderTable = (gateName, rows) => {
  const header = ["CHECK", "ACTUAL", "LIMIT", "STATUS"];
  const cells = rows.map((row) => [
    row.check,
    String(row.actual),
    `<= ${row.limit}${row.overridden ? " (env override)" : ""}`,
    row.ok ? "PASS" : "FAIL",
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((row) => row[column].length))
  );
  const line = (row) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  const output = [
    ``,
    `Goal gate: ${gateName}`,
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...cells.map(line),
    ``,
    ...rows.filter((row) => !row.ok).map((row) => `FAIL ${row.check}: ${row.detail}`),
  ];
  process.stdout.write(`${output.join("\n")}\n`);
  return rows.every((row) => row.ok);
};

// --- Token gate -------------------------------------------------------------

const runTokenGate = async () => {
  log("Token gate: measuring deterministic context packs...");
  await runNode(["sandbox/token-budget/run.mjs"]);
  const resultPath = resolve(
    root,
    "sandbox/token-budget/results/token-budget-latest.json",
  );
  const report = JSON.parse(await readFile(resultPath, "utf8"));
  const agentix = report.scenarios?.agentix;
  const express = report.scenarios?.express;
  if (agentix === undefined || express === undefined) {
    throw new TypeError(`${resultPath} is missing the agentix or express arm.`);
  }

  const fullSrcRatio = numberOverride("GOAL_GATE_FULL_SRC_RATIO_MAX", 1);
  const writeMax = numberOverride("GOAL_GATE_WRITE_FILE_COUNT_MAX", 2);
  const readRatio = numberOverride("GOAL_GATE_READ_DIRECT_RATIO_MAX", 1);
  const affectedMax = numberOverride("GOAL_GATE_AFFECTED_TOKENS_MAX", 200);

  const agentixFullSrc = agentix["full-src"].estimatedTokens;
  const expressFullSrc = express["full-src"].estimatedTokens;
  const fullSrcLimit = expressFullSrc * fullSrcRatio.value;

  const writeCount = agentix["change-cost"].write.fileCount;

  const agentixRead = agentix["change-cost"].read.direct.estimatedTokens;
  const expressRead = express["change-cost"].read.direct.estimatedTokens;
  const readLimit = expressRead * readRatio.value;

  const affectedTokens = agentix.affected.estimatedTokens;

  const rows = [
    {
      check: "full-src est. tokens: agentix <= express",
      actual: agentixFullSrc,
      limit: fullSrcLimit,
      overridden: fullSrcRatio.overridden,
      ok: agentixFullSrc <= fullSrcLimit,
      detail:
        `agentix full-src is ${agentixFullSrc} est. tokens but express is ` +
        `${expressFullSrc} (allowed ratio ${fullSrcRatio.value}).`,
    },
    {
      check: "change-cost WRITE file count: agentix",
      actual: writeCount,
      limit: writeMax.value,
      overridden: writeMax.overridden,
      ok: writeCount <= writeMax.value,
      detail:
        `the scripted change task now touches ${writeCount} agentix files ` +
        `(${agentix["change-cost"].write.files.join(", ")}).`,
    },
    {
      check: "change-cost READ direct est. tokens: agentix <= express",
      actual: agentixRead,
      limit: readLimit,
      overridden: readRatio.overridden,
      ok: agentixRead <= readLimit,
      detail:
        `agentix direct reads cost ${agentixRead} est. tokens but express ` +
        `costs ${expressRead} (allowed ratio ${readRatio.value}).`,
    },
    {
      check: "affected est. tokens: agentix",
      actual: affectedTokens,
      limit: affectedMax.value,
      overridden: affectedMax.overridden,
      ok: affectedTokens <= affectedMax.value,
      detail:
        `\`agentix affected ${report.operation}\` output grew to ` +
        `${affectedTokens} est. tokens.`,
    },
  ];
  return renderTable("token", rows);
};

// --- Perf gate --------------------------------------------------------------

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const dispatchMeanNanoseconds = async (warmups, measured) => {
  const { runRuntimeBenchmark } = await import(
    pathToFileURL(resolve(root, "benchmarks/runtime/dist/index.js")).href
  );
  const report = await runRuntimeBenchmark({
    repositoryRoot: root,
    mode: "smoke",
    warmupIterations: warmups,
    measuredIterations: measured,
    includeProcessMetrics: false,
    includeToolchainMetrics: false,
  });
  const samples = report.samples
    .filter((sample) =>
      sample.metric === "command-dispatch" &&
      sample.implementation === "framework" &&
      sample.phase === "measured"
    )
    .map((sample) => sample.value);
  if (samples.length === 0) {
    throw new TypeError("The runtime smoke produced no measured framework dispatch samples.");
  }
  return mean(samples);
};

const httpEchoMedians = async (warmups, measured) => {
  const { stdout } = await runNode([
    "benchmarks/runtime/dist/http-comparison/cli.js",
    `--root=${root}`,
    `--warmups=${warmups}`,
    `--measured=${measured}`,
    "--no-process",
  ]);
  const report = JSON.parse(stdout);
  const median = (stack) => {
    const summary = report.summaries.find((entry) =>
      entry.metric === "http-valid" && entry.condition === "default" &&
      entry.stack === stack
    );
    if (summary === undefined) {
      const reasons = report.unavailable
        .filter((entry) => entry.stack === stack && entry.metric === "http-valid")
        .map((entry) => entry.reason);
      throw new TypeError(
        `No http-valid/default summary for ${stack}.` +
        (reasons.length > 0 ? ` Reasons: ${[...new Set(reasons)].join("; ")}` : ""),
      );
    }
    return summary.distribution.median;
  };
  return { agentix: median("agentix-node"), express: median("express") };
};

const runPerfGate = async () => {
  const dispatchMax = numberOverride("GOAL_GATE_DISPATCH_MEAN_US_MAX", 5);
  const echoRatioMax = numberOverride("GOAL_GATE_ECHO_MEDIAN_RATIO_MAX", 1.25);
  const dispatchWarmups = numberOverride("GOAL_GATE_DISPATCH_WARMUPS", 100).value;
  const dispatchMeasured = numberOverride("GOAL_GATE_DISPATCH_MEASURED", 60).value;
  const httpWarmups = numberOverride("GOAL_GATE_HTTP_WARMUPS", 20).value;
  const httpMeasured = numberOverride("GOAL_GATE_HTTP_MEASURED", 60).value;
  const runs = numberOverride("GOAL_GATE_PERF_RUNS", 2).value;

  const dispatchRuns = [];
  for (let run = 0; run < runs; run += 1) {
    log(`Perf gate: dispatch run ${run + 1}/${runs} ` +
      `(in-process, ${dispatchWarmups} warmups, ${dispatchMeasured} measured)...`);
    dispatchRuns.push(await dispatchMeanNanoseconds(dispatchWarmups, dispatchMeasured));
  }
  const bestDispatchUs = Math.min(...dispatchRuns) / 1000;

  const httpRuns = [];
  for (let run = 0; run < runs; run += 1) {
    log(`Perf gate: http-comparison run ${run + 1}/${runs} ` +
      `(in-process, ${httpWarmups} warmups, ${httpMeasured} measured)...`);
    httpRuns.push(await httpEchoMedians(httpWarmups, httpMeasured));
  }
  const bestHttp = httpRuns.reduce((best, current) =>
    current.agentix / current.express < best.agentix / best.express ? current : best
  );
  const echoRatio = bestHttp.agentix / bestHttp.express;

  const rows = [
    {
      check: `framework dispatch mean us (best of ${runs})`,
      actual: bestDispatchUs.toFixed(3),
      limit: dispatchMax.value,
      overridden: dispatchMax.overridden,
      ok: bestDispatchUs <= dispatchMax.value,
      detail:
        `steady-state command-dispatch mean regressed to ${bestDispatchUs.toFixed(3)}us ` +
        `(all runs: ${dispatchRuns.map((value) => (value / 1000).toFixed(3)).join(", ")}us); ` +
        "the production echo dispatch normally sits near 1us.",
    },
    {
      check: `echo-valid median ratio agentix/express (best of ${runs})`,
      actual: echoRatio.toFixed(3),
      limit: echoRatioMax.value,
      overridden: echoRatioMax.overridden,
      ok: echoRatio <= echoRatioMax.value,
      detail:
        `agentix echo-valid median ${(bestHttp.agentix / 1000).toFixed(1)}us vs express ` +
        `${(bestHttp.express / 1000).toFixed(1)}us in the in-process default condition ` +
        `(all run ratios: ${httpRuns.map((run) => (run.agentix / run.express).toFixed(3)).join(", ")}).`,
    },
  ];
  return renderTable("perf", rows);
};

// --- Entry point ------------------------------------------------------------

const gate = process.argv[2];
const gates = { token: runTokenGate, perf: runPerfGate };
if (process.argv.length !== 3 || gates[gate] === undefined) {
  process.stderr.write(
    "Usage: node scripts/check-goal-gates.mjs <token|perf>\n",
  );
  process.exit(2);
}
const passed = await gates[gate]();
if (!passed) {
  process.stderr.write(`Goal gate '${gate}' FAILED.\n`);
  process.exit(1);
}
log(`Goal gate '${gate}' passed.`);
