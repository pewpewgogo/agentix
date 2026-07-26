import { execFile } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { generateIndex } from "@agentix/compiler";
import { command, createApplication, feature, principal, s } from "@agentix/core";
import { z } from "zod";

import { canonicalJson, hashJson, sha256, assertSha256 } from "./evidence.js";
import {
  coldStartProbe,
  measureToolchain,
  memoryProbe,
  prepareBuiltArm,
  systemCommandExecutor,
  type BuiltArmEvidence,
  type RuntimeCommandExecutor,
  type ToolchainMetric,
} from "./execution.js";
import { interleavedArmSchedule, type RuntimeArm } from "./schedule.js";
import { summarize, type Distribution } from "./statistics.js";

const execFileAsync = promisify(execFile);

const commandText = async (
  repositoryRoot: string,
  command: readonly [string, ...string[]],
): Promise<string | null> => {
  const [executable, ...arguments_] = command;
  try {
    return (await execFileAsync(executable, arguments_, {
      cwd: repositoryRoot,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 16 * 1024 * 1024,
    })).stdout.trim();
  } catch {
    return null;
  }
};

const sourceManifest = async (
  repositoryRoot: string,
  patterns: readonly string[],
): Promise<string> => {
  const files: string[] = [];
  for (const pattern of patterns) {
    for await (const file of glob(pattern, { cwd: repositoryRoot })) files.push(file);
  }
  const unique = [...new Set(files)].sort();
  const entries = await Promise.all(unique.map(async (file) => ({
    file,
    sha256: sha256(await readFile(resolve(repositoryRoot, file))),
  })));
  return hashJson(entries);
};

export interface RepositoryEvidence {
  readonly gitCommit: string | null;
  readonly dirty: boolean;
  readonly packageLockSha256: string;
  readonly runtimeSourceManifestSha256: string;
  readonly applicationSourceManifestSha256: string;
}

const captureRepositoryEvidence = async (
  repositoryRoot: string,
): Promise<RepositoryEvidence> => {
  const [gitCommit, gitStatus, runtimeSourceManifestSha256,
    applicationSourceManifestSha256, packageLock] = await Promise.all([
      commandText(repositoryRoot, ["git", "rev-parse", "HEAD"]),
      commandText(repositoryRoot, ["git", "status", "--porcelain=v1"]),
      sourceManifest(repositoryRoot, [
        "benchmarks/runtime/src/**/*.ts",
        "benchmarks/runtime/*.json",
        "benchmarks/runtime/*.md",
      ]),
      sourceManifest(repositoryRoot, [
        "packages/*/src/**/*.ts",
        "packages/*/package.json",
        "packages/*/tsconfig*.json",
        "examples/*/src/**/*.ts",
        "examples/*/package.json",
        "examples/*/tsconfig*.json",
        "package.json",
        "tsconfig*.json",
        "vitest.config.ts",
      ]),
      readFile(resolve(repositoryRoot, "package-lock.json")),
    ]);
  return {
    gitCommit,
    dirty: gitStatus === null || gitStatus.length > 0,
    packageLockSha256: sha256(packageLock),
    runtimeSourceManifestSha256,
    applicationSourceManifestSha256,
  };
};

export type RuntimeMetric =
  | "cold-start"
  | "command-dispatch"
  | "schema-valid"
  | "schema-invalid"
  | "index-generation"
  | "retained-rss-delta-100-systems"
  | "process-max-rss-100-systems"
  | ToolchainMetric;

export type RuntimeImplementation = RuntimeArm | "framework-only";
export type RuntimePhase = "warmup" | "measured";

export interface RuntimeSample {
  readonly metric: RuntimeMetric;
  readonly implementation: RuntimeImplementation;
  readonly iteration: number;
  readonly value: number;
  readonly unit: "nanoseconds" | "bytes";
  readonly phase: RuntimePhase;
}

export interface RuntimeMetricSummary {
  readonly metric: RuntimeMetric;
  readonly implementation: RuntimeImplementation;
  readonly unit: RuntimeSample["unit"];
  readonly distribution: Distribution;
}

export interface RuntimeUnavailable {
  readonly metric: RuntimeMetric;
  readonly implementation: RuntimeImplementation;
  readonly iteration: number | null;
  readonly phase: RuntimePhase | null;
  readonly stage: "configuration" | "probe" | "prerequisite" | "measurement";
  readonly reason: string;
}

export interface RuntimeBenchmarkConfiguration {
  readonly warmupIterations: number;
  readonly measuredIterations: number;
  readonly toolchainIterations: number;
  readonly processMetrics: boolean;
  readonly toolchainMetrics: boolean;
}

export interface RuntimeEligibility {
  readonly confirmatory: boolean;
  readonly reasons: readonly string[];
}

export interface RuntimeBenchmarkReport {
  readonly schemaVersion: 2;
  readonly kind: "runtime-benchmark";
  readonly mode: "smoke" | "confirmatory";
  readonly generatedAt: string;
  readonly seed: string;
  readonly configuration: RuntimeBenchmarkConfiguration;
  readonly environment: {
    readonly node: string;
    readonly npm: string;
    readonly typescript: string;
    readonly platform: string;
    readonly arch: string;
    readonly osRelease: string;
    readonly cpuModel: string;
    readonly cpuCount: number;
    readonly totalMemoryBytes: number;
    readonly commandExecutor: RuntimeCommandExecutor["kind"];
  };
  readonly repository: RepositoryEvidence;
  readonly evidence: {
    readonly measurementPlanSha256: string;
    readonly processBuilds: readonly BuiltArmEvidence[];
  };
  readonly eligibility: RuntimeEligibility;
  readonly samples: readonly RuntimeSample[];
  readonly summaries: readonly RuntimeMetricSummary[];
  readonly unavailable: readonly RuntimeUnavailable[];
}

export interface RuntimeBenchmarkOptions {
  readonly repositoryRoot: string;
  readonly mode: "smoke" | "confirmatory";
  readonly seed?: string;
  readonly warmupIterations?: number;
  readonly measuredIterations?: number;
  readonly includeProcessMetrics?: boolean;
  readonly includeToolchainMetrics?: boolean;
  readonly toolchainIterations?: number;
  readonly now?: () => string;
  /** Test doubles are accepted only for smoke-mode failure-path tests. */
  readonly executor?: RuntimeCommandExecutor;
}

// v2-API echo feature. Rewriting the dispatch target changes the identity of
// this benchmark's records: runs of this file are not comparable with v1-API
// runs and are published as new result files only.
const EchoInput = s.object({ value: s.number() });
const echoFeature = feature("runtime", {
  operations: {
    echo: command({
      input: EchoInput,
      output: s.number(),
      permissions: ["runtime:dispatch"],
      execute({ input }) {
        return input.value;
      },
    }),
  },
});
const echo = echoFeature.operations.echo;
const echoApplication = createApplication({ features: [echoFeature], adapters: [] });
const echoPrincipal = principal("runtime-benchmark", ["runtime:dispatch"]);
const PlainEchoInput = z.strictObject({ value: z.number() });
// Construction is outside the timer, matching the framework principal above.
const plainPermissions = new Set(["runtime:dispatch"]);

const plainDispatch = (input: unknown): number => {
  if (!plainPermissions.has("runtime:dispatch")) throw new Error("Permission denied.");
  return PlainEchoInput.parse(input).value;
};

const elapsedNs = async (operation: () => unknown | Promise<unknown>): Promise<number> => {
  const start = process.hrtime.bigint();
  await operation();
  return Number(process.hrtime.bigint() - start);
};

const sampleCount = (
  samples: readonly RuntimeSample[],
  metric: RuntimeMetric,
  implementation: RuntimeImplementation,
  phase: RuntimePhase,
): number => samples.filter((sample) =>
  sample.metric === metric && sample.implementation === implementation &&
  sample.phase === phase
).length;

const pushSample = (
  samples: RuntimeSample[],
  sample: RuntimeSample,
): void => {
  if (!Number.isFinite(sample.value) || !Number.isSafeInteger(sample.value)) {
    throw new TypeError(`${sample.metric} returned a non-finite or unsafe measurement.`);
  }
  if (sample.unit === "nanoseconds" && sample.value < 0) {
    throw new RangeError(`${sample.metric} returned a negative duration.`);
  }
  samples.push(Object.freeze(sample));
};

const pushInterleavedSamples = async (
  samples: RuntimeSample[],
  metric: RuntimeMetric,
  warmups: number,
  iterations: number,
  seed: string,
  measure: (arm: RuntimeArm) => unknown | Promise<unknown>,
): Promise<void> => {
  const runPhase = async (count: number, phase: RuntimePhase): Promise<void> => {
    if (count === 0) return;
    for (const arm of interleavedArmSchedule(count, `${seed}:${metric}:${phase}`)) {
      const value = await elapsedNs(() => measure(arm));
      pushSample(samples, {
        metric,
        implementation: arm,
        iteration: sampleCount(samples, metric, arm, phase),
        value,
        unit: "nanoseconds",
        phase,
      });
    }
  };
  await runPhase(warmups, "warmup");
  await runPhase(iterations, "measured");
};

const summarizeSamples = (
  samples: readonly RuntimeSample[],
): readonly RuntimeMetricSummary[] => {
  const groups = new Map<string, RuntimeSample[]>();
  for (const sample of samples.filter((entry) => entry.phase === "measured")) {
    const key = `${sample.metric}\u0000${sample.implementation}\u0000${sample.unit}`;
    const values = groups.get(key) ?? [];
    values.push(sample);
    groups.set(key, values);
  }
  return Object.freeze([...groups.values()].map((entries) => Object.freeze({
    metric: entries[0]!.metric,
    implementation: entries[0]!.implementation,
    unit: entries[0]!.unit,
    distribution: summarize(entries.map(({ value }) => value)),
  })).sort((left, right) =>
    `${left.metric}:${left.implementation}`.localeCompare(
      `${right.metric}:${right.implementation}`,
    )
  ));
};

const measurementPlanDocument = (
  seed: string,
  configuration: RuntimeBenchmarkConfiguration,
): Readonly<Record<string, unknown>> => ({
  protocol: "agentix-runtime-v2",
  // The dispatch target moved to the v2 core API (feature()/command()); this
  // field changes the measurement-plan hash so v2-API runs can never be
  // mistaken for continuations of v1-API record lineages.
  dispatchTargetApi: "agentix-core-v2",
  seed,
  configuration,
  armOrder: "seeded-balanced-two-arm-blocks",
  summaries: "measured-only-r7-median-iqr-p95-range-with-raw-values",
  inProcessMetrics: [
    "command-dispatch",
    "schema-valid",
    "schema-invalid",
    "index-generation-framework-only",
  ],
  processMetrics: {
    freshIsolatedBuildPerArm: true,
    copiedDistAllowed: false,
    exactEntryAndWorkspaceOutputsHashed: true,
    coldStart: "fresh-node-esm-import",
    memory: "100-live-systems-after-explicit-gc",
    retainedRss: "signed-bytes",
    maxRss: "process.resourceUsage.maxRSS-kib-normalized-to-bytes",
  },
  toolchainMetrics: {
    freshIsolatedWorkspacePerObservation: true,
    provisioningExcluded: true,
    frameworkFullTypecheckCompilerBootstrapExcluded: true,
    failedCommandsAreUnavailableNotNumericSamples: true,
    incrementalPrerequisites: "arm-local-app-and-required-framework-cli-only",
    incrementalEdit: "frozen-semantic-customer-validation-message-change",
  },
});

export const runtimeMeasurementPlanSha256 = (
  seed: string,
  configuration: RuntimeBenchmarkConfiguration,
): string => hashJson(measurementPlanDocument(seed, configuration));

const requiredSampleGroups = (
  configuration: RuntimeBenchmarkConfiguration,
): readonly {
  readonly metric: RuntimeMetric;
  readonly implementation: RuntimeImplementation;
  readonly phase: RuntimePhase;
  readonly expected: number;
}[] => {
  const groups: Array<{
    metric: RuntimeMetric;
    implementation: RuntimeImplementation;
    phase: RuntimePhase;
    expected: number;
  }> = [];
  for (const metric of [
    "command-dispatch", "schema-valid", "schema-invalid", "cold-start",
  ] as const) {
    for (const implementation of ["framework", "plain"] as const) {
      groups.push(
        { metric, implementation, phase: "warmup", expected: configuration.warmupIterations },
        { metric, implementation, phase: "measured", expected: configuration.measuredIterations },
      );
    }
  }
  groups.push(
    {
      metric: "index-generation",
      implementation: "framework-only",
      phase: "warmup",
      expected: configuration.warmupIterations,
    },
    {
      metric: "index-generation",
      implementation: "framework-only",
      phase: "measured",
      expected: configuration.measuredIterations,
    },
  );
  for (const metric of [
    "retained-rss-delta-100-systems", "process-max-rss-100-systems",
  ] as const) {
    for (const implementation of ["framework", "plain"] as const) {
      groups.push({
        metric,
        implementation,
        phase: "measured",
        expected: configuration.measuredIterations,
      });
    }
  }
  for (const metric of [
    "clean-build", "full-typecheck", "incremental-verification",
  ] as const) {
    for (const implementation of ["framework", "plain"] as const) {
      groups.push({
        metric,
        implementation,
        phase: "measured",
        expected: configuration.toolchainIterations,
      });
    }
  }
  return groups;
};

type EligibilityInput = Pick<
  RuntimeBenchmarkReport,
  "mode" | "configuration" | "environment" | "repository" | "evidence" |
  "samples" | "unavailable"
>;

export const assessRuntimeEligibility = (
  input: EligibilityInput,
): RuntimeEligibility => {
  if (input.mode === "smoke") {
    return Object.freeze({
      confirmatory: false,
      reasons: Object.freeze(["mode-is-smoke"]),
    });
  }
  const reasons: string[] = [];
  if (input.configuration.warmupIterations < 10) reasons.push("warmups-below-10");
  if (input.configuration.measuredIterations < 30) reasons.push("measurements-below-30");
  if (input.configuration.toolchainIterations < 10) reasons.push("toolchain-measurements-below-10");
  if (!input.configuration.processMetrics) reasons.push("process-metrics-disabled");
  if (!input.configuration.toolchainMetrics) reasons.push("toolchain-metrics-disabled");
  if (input.environment.commandExecutor !== "system") reasons.push("non-system-command-executor");
  if (input.environment.npm === "unavailable") reasons.push("npm-version-unavailable");
  if (input.environment.typescript === "unavailable") reasons.push("typescript-version-unavailable");
  if (input.repository.gitCommit === null) reasons.push("git-commit-unavailable");
  if (input.repository.dirty) reasons.push("repository-dirty");
  for (const arm of ["framework", "plain"] as const) {
    if (!input.evidence.processBuilds.some(({ implementation }) => implementation === arm)) {
      reasons.push(`fresh-process-build-missing:${arm}`);
    }
  }
  for (const group of requiredSampleGroups(input.configuration)) {
    const actual = sampleCount(
      input.samples,
      group.metric,
      group.implementation,
      group.phase,
    );
    if (actual !== group.expected) {
      reasons.push(
        `sample-count:${group.metric}:${group.implementation}:${group.phase}:${actual}/${group.expected}`,
      );
    }
  }
  for (const unavailable of input.unavailable) {
    reasons.push(`unavailable:${unavailable.metric}:${unavailable.implementation}`);
  }
  const unique = Object.freeze([...new Set(reasons)].sort());
  return Object.freeze({ confirmatory: unique.length === 0, reasons: unique });
};

const allMetrics = new Set<RuntimeMetric>([
  "cold-start",
  "command-dispatch",
  "schema-valid",
  "schema-invalid",
  "index-generation",
  "retained-rss-delta-100-systems",
  "process-max-rss-100-systems",
  "clean-build",
  "full-typecheck",
  "incremental-verification",
]);
const allImplementations = new Set<RuntimeImplementation>([
  "framework", "plain", "framework-only",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  name: string,
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(sortedExpected)) {
    throw new TypeError(`${name} contains missing or unexpected fields.`);
  }
};

const assertNonNegativeSafeInteger = (name: string, value: unknown): void => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
};

/** Strict enough for untrusted publication reads; summaries and eligibility are recomputed. */
export function validateRuntimeBenchmarkReport(
  value: unknown,
): asserts value is RuntimeBenchmarkReport {
  if (!isRecord(value) || value["schemaVersion"] !== 2 ||
      value["kind"] !== "runtime-benchmark") {
    throw new TypeError("Runtime report must be a schema-version 2 runtime-benchmark.");
  }
  assertExactKeys("Runtime report", value, [
    "schemaVersion", "kind", "mode", "generatedAt", "seed", "configuration",
    "environment", "repository", "evidence", "eligibility", "samples",
    "summaries", "unavailable",
  ]);
  const report = value as unknown as RuntimeBenchmarkReport;
  if (report.mode !== "smoke" && report.mode !== "confirmatory") {
    throw new TypeError("Runtime report mode is invalid.");
  }
  if (typeof report.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(report.generatedAt))) {
    throw new TypeError("Runtime report generatedAt must be an ISO-compatible date.");
  }
  if (typeof report.seed !== "string" || report.seed.length === 0) {
    throw new TypeError("Runtime report seed must be non-empty.");
  }
  if (!isRecord(report.configuration)) throw new TypeError("Runtime configuration is invalid.");
  assertExactKeys("Runtime configuration", report.configuration, [
    "warmupIterations", "measuredIterations", "toolchainIterations",
    "processMetrics", "toolchainMetrics",
  ]);
  assertNonNegativeSafeInteger("warmupIterations", report.configuration.warmupIterations);
  if (!Number.isSafeInteger(report.configuration.measuredIterations) ||
      report.configuration.measuredIterations < 1) {
    throw new TypeError("measuredIterations must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(report.configuration.toolchainIterations) ||
      report.configuration.toolchainIterations < 1) {
    throw new TypeError("toolchainIterations must be a positive safe integer.");
  }
  if (typeof report.configuration.processMetrics !== "boolean" ||
      typeof report.configuration.toolchainMetrics !== "boolean") {
    throw new TypeError("Runtime metric-group flags must be booleans.");
  }
  if (!isRecord(report.environment) ||
      (report.environment.commandExecutor !== "system" &&
       report.environment.commandExecutor !== "test-double")) {
    throw new TypeError("Runtime environment evidence is invalid.");
  }
  assertExactKeys("Runtime environment", report.environment, [
    "node", "npm", "typescript", "platform", "arch", "osRelease", "cpuModel",
    "cpuCount", "totalMemoryBytes", "commandExecutor",
  ]);
  for (const key of ["node", "npm", "typescript", "platform", "arch", "osRelease", "cpuModel"] as const) {
    if (typeof report.environment[key] !== "string" || report.environment[key].length === 0) {
      throw new TypeError(`Runtime environment ${key} is invalid.`);
    }
  }
  assertNonNegativeSafeInteger("cpuCount", report.environment.cpuCount);
  assertNonNegativeSafeInteger("totalMemoryBytes", report.environment.totalMemoryBytes);
  if (!isRecord(report.repository)) throw new TypeError("Runtime repository evidence is invalid.");
  assertExactKeys("Runtime repository evidence", report.repository, [
    "gitCommit", "dirty", "packageLockSha256", "runtimeSourceManifestSha256",
    "applicationSourceManifestSha256",
  ]);
  if (report.repository.gitCommit !== null &&
      (typeof report.repository.gitCommit !== "string" ||
       !/^[a-f0-9]{40,64}$/u.test(report.repository.gitCommit))) {
    throw new TypeError("Runtime Git commit evidence is invalid.");
  }
  if (typeof report.repository.dirty !== "boolean") throw new TypeError("Runtime dirty state is invalid.");
  assertSha256("packageLockSha256", report.repository.packageLockSha256);
  assertSha256("runtimeSourceManifestSha256", report.repository.runtimeSourceManifestSha256);
  assertSha256("applicationSourceManifestSha256", report.repository.applicationSourceManifestSha256);
  if (!isRecord(report.evidence) || !Array.isArray(report.evidence.processBuilds)) {
    throw new TypeError("Runtime process-build evidence is invalid.");
  }
  assertExactKeys("Runtime evidence", report.evidence, [
    "measurementPlanSha256", "processBuilds",
  ]);
  assertSha256("measurementPlanSha256", report.evidence.measurementPlanSha256);
  const expectedPlan = runtimeMeasurementPlanSha256(report.seed, report.configuration);
  if (report.evidence.measurementPlanSha256 !== expectedPlan) {
    throw new TypeError("Runtime measurement-plan hash does not match the report configuration.");
  }
  const buildArms = new Set<RuntimeArm>();
  for (const buildValue of report.evidence.processBuilds as readonly unknown[]) {
    if (!isRecord(buildValue)) {
      throw new TypeError("Runtime process-build arm is invalid.");
    }
    assertExactKeys("Runtime process-build evidence", buildValue, [
      "implementation", "buildCommand", "entryRelativePath", "entrySha256",
      "outputManifestSha256", "workspaceOutputManifestSha256",
      "sourceManifestSha256",
    ]);
    const build = buildValue as unknown as BuiltArmEvidence;
    if (build.implementation !== "framework" && build.implementation !== "plain") {
      throw new TypeError("Runtime process-build arm is invalid.");
    }
    if (buildArms.has(build.implementation)) throw new TypeError("Runtime process-build arm is duplicated.");
    buildArms.add(build.implementation);
    const workspace = build.implementation === "framework"
      ? "@agentix/framework-app"
      : "@agentix/plain-app";
    if (canonicalJson(build.buildCommand) !== canonicalJson([
      "npm", "run", "build", "--workspace", workspace,
    ])) {
      throw new TypeError("Runtime process-build command evidence is invalid.");
    }
    const directory = build.implementation === "framework"
      ? "examples/framework-app"
      : "examples/plain-app";
    if (build.entryRelativePath !== `${directory}/dist/index.js`) {
      throw new TypeError("Runtime process entry evidence is invalid.");
    }
    assertSha256("entrySha256", build.entrySha256);
    assertSha256("outputManifestSha256", build.outputManifestSha256);
    assertSha256("workspaceOutputManifestSha256", build.workspaceOutputManifestSha256);
    assertSha256("sourceManifestSha256", build.sourceManifestSha256);
  }
  if (!report.configuration.processMetrics && buildArms.size > 0) {
    throw new TypeError("Disabled process metrics cannot contain fresh-build evidence.");
  }
  if (!Array.isArray(report.samples)) throw new TypeError("Runtime samples must be an array.");
  const sampleKeys = new Set<string>();
  const sampleIterations = new Map<string, number[]>();
  for (const sampleValue of report.samples as readonly unknown[]) {
    if (!isRecord(sampleValue)) {
      throw new TypeError("Runtime sample metric or implementation is invalid.");
    }
    assertExactKeys("Runtime sample", sampleValue, [
      "metric", "implementation", "iteration", "value", "unit", "phase",
    ]);
    const sample = sampleValue as unknown as RuntimeSample;
    if (!allMetrics.has(sample.metric as RuntimeMetric) ||
        !allImplementations.has(sample.implementation as RuntimeImplementation)) {
      throw new TypeError("Runtime sample metric or implementation is invalid.");
    }
    assertNonNegativeSafeInteger("sample iteration", sample.iteration);
    if (typeof sample.value !== "number" || !Number.isSafeInteger(sample.value)) {
      throw new TypeError("Runtime sample value must be a safe integer.");
    }
    if (sample.unit !== "nanoseconds" && sample.unit !== "bytes") {
      throw new TypeError("Runtime sample unit is invalid.");
    }
    if (sample.phase !== "warmup" && sample.phase !== "measured") {
      throw new TypeError("Runtime sample phase is invalid.");
    }
    const bytes = sample.metric === "retained-rss-delta-100-systems" ||
      sample.metric === "process-max-rss-100-systems";
    if ((bytes && sample.unit !== "bytes") || (!bytes && sample.unit !== "nanoseconds")) {
      throw new TypeError("Runtime sample unit does not match its metric.");
    }
    if (sample.metric === "index-generation" && sample.implementation !== "framework-only") {
      throw new TypeError("Index generation must be framework-only.");
    }
    if (sample.metric !== "index-generation" && sample.implementation === "framework-only") {
      throw new TypeError("Only index generation may be framework-only.");
    }
    const processMetric = sample.metric === "cold-start" ||
      sample.metric === "retained-rss-delta-100-systems" ||
      sample.metric === "process-max-rss-100-systems";
    const toolchainMetric = sample.metric === "clean-build" ||
      sample.metric === "full-typecheck" ||
      sample.metric === "incremental-verification";
    if (processMetric && !report.configuration.processMetrics) {
      throw new TypeError("Disabled process metrics cannot contain samples.");
    }
    if (toolchainMetric && !report.configuration.toolchainMetrics) {
      throw new TypeError("Disabled toolchain metrics cannot contain samples.");
    }
    if (processMetric && sample.implementation !== "framework-only" &&
        !buildArms.has(sample.implementation)) {
      throw new TypeError("Process samples require matching fresh-build evidence.");
    }
    if ((sample.metric === "retained-rss-delta-100-systems" ||
         sample.metric === "process-max-rss-100-systems" || toolchainMetric) &&
        sample.phase !== "measured") {
      throw new TypeError(`${sample.metric} does not define warmup samples.`);
    }
    const group = `${sample.metric}\u0000${sample.implementation}\u0000${sample.phase}`;
    const key = `${group}\u0000${sample.iteration}`;
    if (sampleKeys.has(key)) throw new TypeError("Runtime sample iteration is duplicated.");
    sampleKeys.add(key);
    const iterations = sampleIterations.get(group) ?? [];
    iterations.push(sample.iteration);
    sampleIterations.set(group, iterations);
  }
  for (const iterations of sampleIterations.values()) {
    iterations.sort((left, right) => left - right);
    if (iterations.some((iteration, index) => iteration !== index)) {
      throw new TypeError("Runtime sample iterations must be contiguous from zero.");
    }
  }
  if (!Array.isArray(report.unavailable)) throw new TypeError("Runtime unavailable evidence must be an array.");
  for (const unavailableValue of report.unavailable as readonly unknown[]) {
    if (!isRecord(unavailableValue)) {
      throw new TypeError("Runtime unavailable metric or implementation is invalid.");
    }
    assertExactKeys("Runtime unavailable evidence", unavailableValue, [
      "metric", "implementation", "iteration", "phase", "stage", "reason",
    ]);
    const unavailable = unavailableValue as unknown as RuntimeUnavailable;
    if (!allMetrics.has(unavailable.metric as RuntimeMetric) ||
        !allImplementations.has(unavailable.implementation as RuntimeImplementation)) {
      throw new TypeError("Runtime unavailable metric or implementation is invalid.");
    }
    if (unavailable.iteration !== null) assertNonNegativeSafeInteger("unavailable iteration", unavailable.iteration);
    if (unavailable.phase !== null && unavailable.phase !== "warmup" && unavailable.phase !== "measured") {
      throw new TypeError("Runtime unavailable phase is invalid.");
    }
    if (!new Set(["configuration", "probe", "prerequisite", "measurement"]).has(unavailable.stage)) {
      throw new TypeError("Runtime unavailable stage is invalid.");
    }
    if (typeof unavailable.reason !== "string" || unavailable.reason.length === 0) {
      throw new TypeError("Runtime unavailable reason must be non-empty.");
    }
  }
  if (!Array.isArray(report.summaries)) throw new TypeError("Runtime summaries must be an array.");
  const expectedSummaries = summarizeSamples(report.samples);
  if (canonicalJson(report.summaries) !== canonicalJson(expectedSummaries)) {
    throw new TypeError("Runtime summaries do not match measured raw samples.");
  }
  if (!isRecord(report.eligibility) || !Array.isArray(report.eligibility.reasons)) {
    throw new TypeError("Runtime eligibility evidence is invalid.");
  }
  const expectedEligibility = assessRuntimeEligibility(report);
  if (canonicalJson(report.eligibility) !== canonicalJson(expectedEligibility)) {
    throw new TypeError("Runtime confirmatory eligibility does not match the evidence.");
  }
}

const positiveSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
};

const nonNegativeSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
};

const unavailableForDisabledGroup = (
  metrics: readonly RuntimeMetric[],
  reason: string,
): readonly RuntimeUnavailable[] => metrics.flatMap((metric) =>
  (["framework", "plain"] as const).map((implementation) => Object.freeze({
    metric,
    implementation,
    iteration: null,
    phase: null,
    stage: "configuration" as const,
    reason,
  }))
);

export const runRuntimeBenchmark = async (
  options: RuntimeBenchmarkOptions,
): Promise<RuntimeBenchmarkReport> => {
  const executor = options.executor ?? systemCommandExecutor;
  if (options.mode === "confirmatory" && executor.kind !== "system") {
    throw new TypeError("Confirmatory runtime measurement forbids test-double command execution.");
  }
  const seed = options.seed ?? "runtime-smoke-v2";
  if (seed.length === 0) throw new TypeError("Runtime seed must be non-empty.");
  const warmups = nonNegativeSafeInteger("warmupIterations", options.warmupIterations ?? 5);
  const iterations = positiveSafeInteger("measuredIterations", options.measuredIterations ?? 20);
  const toolchainIterations = positiveSafeInteger(
    "toolchainIterations",
    options.toolchainIterations ?? Math.min(iterations, 5),
  );
  const configuration: RuntimeBenchmarkConfiguration = Object.freeze({
    warmupIterations: warmups,
    measuredIterations: iterations,
    toolchainIterations,
    processMetrics: options.includeProcessMetrics === true,
    toolchainMetrics: options.includeToolchainMetrics === true,
  });
  if (options.mode === "confirmatory" && (
    warmups < 10 || iterations < 30 || toolchainIterations < 10 ||
    !configuration.processMetrics || !configuration.toolchainMetrics
  )) {
    throw new TypeError(
      "Confirmatory runtime measurement requires 10 warmups, 30 measured samples, 10 toolchain samples, and all metric groups.",
    );
  }

  const repositoryRoot = resolve(options.repositoryRoot);
  await readFile(resolve(repositoryRoot, "package.json"), "utf8");
  const repositoryEvidence = await captureRepositoryEvidence(repositoryRoot);
  if (options.mode === "confirmatory" &&
      (repositoryEvidence.gitCommit === null || repositoryEvidence.dirty)) {
    throw new TypeError(
      "Confirmatory runtime measurement requires a clean repository at an exact commit.",
    );
  }

  const samples: RuntimeSample[] = [];
  const unavailable: RuntimeUnavailable[] = [];

  await pushInterleavedSamples(
    samples,
    "command-dispatch",
    warmups,
    iterations,
    seed,
    (arm) => arm === "framework"
      ? echoApplication.dispatch(echo, { input: { value: 7 }, principal: echoPrincipal })
      : plainDispatch({ value: 7 }),
  );

  const frameworkSchema = s.object({ id: s.id("runtime"), count: s.number() });
  const plainSchema = z.strictObject({ id: z.string().min(1), count: z.number() });
  for (const [metric, input] of [
    ["schema-valid", { id: "sample", count: 1 }],
    ["schema-invalid", { id: "", count: "bad" }],
  ] as const) {
    await pushInterleavedSamples(samples, metric, warmups, iterations, seed, (arm) => {
      if (arm === "framework") return frameworkSchema.safeParse(input);
      return plainSchema.safeParse(input);
    });
  }

  for (const phase of ["warmup", "measured"] as const) {
    const count = phase === "warmup" ? warmups : iterations;
    for (let iteration = 0; iteration < count; iteration += 1) {
      const value = await elapsedNs(() => generateIndex({
        rootDir: resolve(repositoryRoot, "examples/framework-app"),
        write: false,
      }));
      pushSample(samples, {
        metric: "index-generation",
        implementation: "framework-only",
        iteration,
        value,
        unit: "nanoseconds",
        phase,
      });
    }
  }

  const processBuilds: BuiltArmEvidence[] = [];
  if (configuration.processMetrics) {
    const prepared = new Map<RuntimeArm, Awaited<ReturnType<typeof prepareBuiltArm>> & { ok: true }>();
    try {
      for (const arm of interleavedArmSchedule(1, `${seed}:process-build`)) {
        try {
          const build = await prepareBuiltArm({
            repositoryRoot,
            arm,
            executor,
            // Test doubles never execute the build command, so copying the
            // entire installed dependency tree only adds fixture-size latency.
            includeInstalledDependencies: executor.kind === "system",
          });
          if (build.ok) {
            prepared.set(arm, build);
            processBuilds.push(build.evidence);
          } else {
            for (const metric of [
              "cold-start",
              "retained-rss-delta-100-systems",
              "process-max-rss-100-systems",
            ] as const) {
              unavailable.push(Object.freeze({
                metric,
                implementation: arm,
                iteration: null,
                phase: null,
                stage: "prerequisite",
                reason: build.reason,
              }));
            }
          }
        } catch (cause: unknown) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          for (const metric of [
            "cold-start",
            "retained-rss-delta-100-systems",
            "process-max-rss-100-systems",
          ] as const) {
            unavailable.push(Object.freeze({
              metric,
              implementation: arm,
              iteration: null,
              phase: null,
              stage: "prerequisite",
              reason: `Fresh isolated ${arm} build could not run: ${reason}`,
            }));
          }
        }
      }

      for (const phase of ["warmup", "measured"] as const) {
        const count = phase === "warmup" ? warmups : iterations;
        if (count === 0) continue;
        const attempted = new Map<RuntimeArm, number>([["framework", 0], ["plain", 0]]);
        for (const arm of interleavedArmSchedule(count, `${seed}:cold-start:${phase}`)) {
          const build = prepared.get(arm);
          if (build === undefined) continue;
          const iteration = attempted.get(arm)!;
          attempted.set(arm, iteration + 1);
          let result;
          try {
            result = await coldStartProbe(build, executor);
          } catch (cause: unknown) {
            unavailable.push(Object.freeze({
              metric: "cold-start",
              implementation: arm,
              iteration,
              phase,
              stage: "probe",
              reason: cause instanceof Error ? cause.message : String(cause),
            }));
            continue;
          }
          if (result.exitCode === 0) {
            pushSample(samples, {
              metric: "cold-start",
              implementation: arm,
              iteration,
              value: result.nanoseconds,
              unit: "nanoseconds",
              phase,
            });
          } else {
            unavailable.push(Object.freeze({
              metric: "cold-start",
              implementation: arm,
              iteration,
              phase,
              stage: "probe",
              reason: result.reason ?? `Cold-start child exited ${result.exitCode}.`,
            }));
          }
        }
      }

      const attempted = new Map<RuntimeArm, number>([["framework", 0], ["plain", 0]]);
      for (const arm of interleavedArmSchedule(iterations, `${seed}:memory:measured`)) {
        const build = prepared.get(arm);
        if (build === undefined) continue;
        const iteration = attempted.get(arm)!;
        attempted.set(arm, iteration + 1);
        let result;
        try {
          result = await memoryProbe(build, executor);
        } catch (cause: unknown) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          unavailable.push(
            Object.freeze({
              metric: "retained-rss-delta-100-systems",
              implementation: arm,
              iteration,
              phase: "measured",
              stage: "probe",
              reason,
            }),
            Object.freeze({
              metric: "process-max-rss-100-systems",
              implementation: arm,
              iteration,
              phase: "measured",
              stage: "probe",
              reason,
            }),
          );
          continue;
        }
        if (result.exitCode !== 0 || result.retainedRssBytes === null) {
          unavailable.push(
            Object.freeze({
              metric: "retained-rss-delta-100-systems",
              implementation: arm,
              iteration,
              phase: "measured",
              stage: "probe",
              reason: result.reason ?? "Memory child failed.",
            }),
            Object.freeze({
              metric: "process-max-rss-100-systems",
              implementation: arm,
              iteration,
              phase: "measured",
              stage: "probe",
              reason: result.reason ?? (result.maxRss.available
                ? "Memory child failed."
                : result.maxRss.reason),
            }),
          );
          continue;
        }
        pushSample(samples, {
          metric: "retained-rss-delta-100-systems",
          implementation: arm,
          iteration,
          value: result.retainedRssBytes,
          unit: "bytes",
          phase: "measured",
        });
        if (result.maxRss.available) {
          pushSample(samples, {
            metric: "process-max-rss-100-systems",
            implementation: arm,
            iteration,
            value: result.maxRss.bytes,
            unit: "bytes",
            phase: "measured",
          });
        } else {
          unavailable.push(Object.freeze({
            metric: "process-max-rss-100-systems",
            implementation: arm,
            iteration,
            phase: "measured",
            stage: "probe",
            reason: result.maxRss.reason,
          }));
        }
      }
    } finally {
      await Promise.all([...prepared.values()].map(({ dispose }) => dispose()));
    }
  } else {
    unavailable.push(...unavailableForDisabledGroup(
      ["cold-start", "retained-rss-delta-100-systems", "process-max-rss-100-systems"],
      "Process metrics were not requested.",
    ));
  }

  if (configuration.toolchainMetrics) {
    for (const metric of [
      "clean-build", "full-typecheck", "incremental-verification",
    ] as const) {
      const attempted = new Map<RuntimeArm, number>([["framework", 0], ["plain", 0]]);
      for (const arm of interleavedArmSchedule(
        toolchainIterations,
        `${seed}:${metric}:toolchain`,
      )) {
        const iteration = attempted.get(arm)!;
        attempted.set(arm, iteration + 1);
        try {
          const result = await measureToolchain({
            repositoryRoot,
            metric,
            arm,
            executor,
          });
          if (result.ok) {
            pushSample(samples, {
              metric,
              implementation: arm,
              iteration,
              value: result.nanoseconds,
              unit: "nanoseconds",
              phase: "measured",
            });
          } else {
            unavailable.push(Object.freeze({
              metric,
              implementation: arm,
              iteration,
              phase: "measured",
              stage: result.stage,
              reason: result.reason,
            }));
          }
        } catch (cause: unknown) {
          unavailable.push(Object.freeze({
            metric,
            implementation: arm,
            iteration,
            phase: "measured",
            stage: "prerequisite",
            reason: cause instanceof Error ? cause.message : String(cause),
          }));
        }
      }
    }
  } else {
    unavailable.push(...unavailableForDisabledGroup(
      ["clean-build", "full-typecheck", "incremental-verification"],
      "Toolchain metrics were not requested.",
    ));
  }

  const [npmVersion, typescriptVersion, repositoryAfter] = await Promise.all([
    commandText(repositoryRoot, ["npm", "--version"]),
    commandText(repositoryRoot, [
      process.execPath,
      "node_modules/typescript/bin/tsc",
      "--version",
    ]),
    captureRepositoryEvidence(repositoryRoot),
  ]);
  if (canonicalJson(repositoryAfter) !== canonicalJson(repositoryEvidence)) {
    throw new Error("Repository source or lock state changed during runtime measurement.");
  }
  const hostCpus = cpus();
  const reportWithoutEligibility = {
    schemaVersion: 2 as const,
    kind: "runtime-benchmark" as const,
    mode: options.mode,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    seed,
    configuration,
    environment: Object.freeze({
      node: process.version,
      npm: npmVersion ?? "unavailable",
      typescript: typescriptVersion ?? "unavailable",
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpuModel: hostCpus[0]?.model ?? "unavailable",
      cpuCount: hostCpus.length,
      totalMemoryBytes: totalmem(),
      commandExecutor: executor.kind,
    }),
    repository: Object.freeze(repositoryEvidence),
    evidence: Object.freeze({
      measurementPlanSha256: runtimeMeasurementPlanSha256(seed, configuration),
      processBuilds: Object.freeze([...processBuilds].sort((left, right) =>
        left.implementation.localeCompare(right.implementation)
      )),
    }),
    samples: Object.freeze(samples),
    summaries: summarizeSamples(samples),
    unavailable: Object.freeze(unavailable),
  };
  const report: RuntimeBenchmarkReport = Object.freeze({
    ...reportWithoutEligibility,
    eligibility: assessRuntimeEligibility(reportWithoutEligibility),
  });
  validateRuntimeBenchmarkReport(report);
  return report;
};
