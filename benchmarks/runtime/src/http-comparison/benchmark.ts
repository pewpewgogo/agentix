import { execFile } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { cpus, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { hashJson, sha256 } from "../evidence.js";
import { summarize } from "../statistics.js";
import { interleavedHttpStackSchedule } from "./schedule.js";
import { agentixTarget } from "./targets/agentix.js";
import { expressTarget } from "./targets/express.js";
import { nestjsTarget } from "./targets/nestjs.js";
import {
  INVALID_REQUEST,
  VALID_REQUEST,
  invalidResponse,
  validResponse,
} from "./targets/shared.js";
import {
  HTTP_STACKS,
  type HttpComparisonMetric,
  type HttpComparisonPhase,
  type HttpComparisonReport,
  type HttpComparisonSample,
  type HttpComparisonSummary,
  type HttpComparisonUnavailable,
  type HttpStack,
  type HttpTarget,
  type StartedHttpTarget,
} from "./types.js";

const execFileAsync = promisify(execFile);

const HTTP_METRICS = ["http-valid", "http-invalid"] as const;
const PROCESS_METRICS = [
  "cold-ready",
  "ready-rss",
  "process-max-rss-ready",
] as const;
const TARGETS: readonly HttpTarget[] = [
  agentixTarget,
  expressTarget,
  nestjsTarget,
];

export interface HttpComparisonOptions {
  readonly repositoryRoot: string;
  readonly seed?: string;
  readonly warmupIterations?: number;
  readonly measuredIterations?: number;
  readonly processIterations?: number;
  readonly includeProcessMetrics?: boolean;
  readonly now?: () => string;
}

interface HttpObservation {
  readonly nanoseconds: number;
  readonly status: number;
  readonly contentType: string;
  readonly body: unknown;
}

interface ChildProbe {
  readonly schemaVersion: 1;
  readonly kind: "http-comparison-child-probe";
  readonly stack: HttpStack;
  readonly coldReadyNanoseconds: number;
  readonly readyRssBytes: number;
  readonly processMaxRssBytes: number | null;
  readonly processMaxRssUnavailableReason: string | null;
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

const commandText = async (
  root: string,
  command: readonly [string, ...string[]],
): Promise<string | null> => {
  const [executable, ...arguments_] = command;
  try {
    return (await execFileAsync(executable, arguments_, {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 4 * 1_024 * 1_024,
    })).stdout.trim();
  } catch {
    return null;
  }
};

const comparisonSourceHash = async (root: string): Promise<string> => {
  const files: string[] = [];
  for await (const file of glob(
    "benchmarks/runtime/src/http-comparison/**/*.ts",
    { cwd: root },
  )) {
    files.push(file);
  }
  const entries = await Promise.all(
    [...new Set(files)].sort().map(async (file) => ({
      file,
      sha256: sha256(await readFile(resolve(root, file))),
    })),
  );
  return hashJson(entries);
};

const packageVersions = (
  lockValue: unknown,
): HttpComparisonReport["dependencies"] => {
  if (typeof lockValue !== "object" || lockValue === null ||
      !("packages" in lockValue) || typeof lockValue.packages !== "object" ||
      lockValue.packages === null) {
    throw new TypeError("package-lock.json has no packages map.");
  }
  const packages = lockValue.packages as Record<string, unknown>;
  const version = (path: string): string => {
    const entry = packages[path];
    if (typeof entry !== "object" || entry === null || !("version" in entry) ||
        typeof entry.version !== "string") {
      throw new TypeError(`package-lock.json has no version for ${path}.`);
    }
    return entry.version;
  };
  const root = packages[""];
  const agentix = typeof root === "object" && root !== null &&
      "version" in root && typeof root.version === "string"
    ? root.version
    : "0.0.0";
  return Object.freeze({
    agentix,
    express: version("node_modules/express"),
    nestjsCore: version("node_modules/@nestjs/core"),
    nestjsPlatformExpress: version("node_modules/@nestjs/platform-express"),
  });
};

const postJson = (
  origin: string,
  agent: Agent,
  body: string,
): Promise<HttpObservation> => new Promise((resolveObservation, reject) => {
  const startedAt = process.hrtime.bigint();
  const request = httpRequest(new URL("/echo", origin), {
    method: "POST",
    agent,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    response.once("error", reject);
    response.once("end", () => {
      const nanoseconds = Number(process.hrtime.bigint() - startedAt);
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause: unknown) {
        reject(new SyntaxError("HTTP comparison target returned invalid JSON.", {
          cause,
        }));
        return;
      }
      const contentTypeValue = response.headers["content-type"];
      resolveObservation({
        nanoseconds,
        status: response.statusCode ?? 0,
        contentType: Array.isArray(contentTypeValue)
          ? contentTypeValue.join(",")
          : contentTypeValue ?? "",
        body: parsed,
      });
    });
  });
  request.once("error", reject);
  request.end(body);
});

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const assertHttpContract = (
  metric: (typeof HTTP_METRICS)[number],
  observation: HttpObservation,
): void => {
  const valid = metric === "http-valid";
  const expectedStatus = valid ? 200 : 400;
  const expectedBody = valid ? validResponse(VALID_REQUEST.value) : invalidResponse();
  if (observation.status !== expectedStatus ||
      !observation.contentType.toLowerCase().startsWith("application/json") ||
      !sameJson(observation.body, expectedBody)) {
    throw new Error(
      `${metric} contract mismatch: status=${observation.status} ` +
      `content-type=${observation.contentType} body=${JSON.stringify(observation.body)}`,
    );
  }
};

const pushSample = (
  samples: HttpComparisonSample[],
  sample: HttpComparisonSample,
): void => {
  if (!Number.isSafeInteger(sample.value) || sample.value < 0) {
    throw new RangeError(`${sample.metric}/${sample.stack} produced an invalid sample.`);
  }
  samples.push(Object.freeze(sample));
};

const runHotPhase = async (input: {
  readonly count: number;
  readonly phase: HttpComparisonPhase;
  readonly metric: (typeof HTTP_METRICS)[number];
  readonly seed: string;
  readonly started: ReadonlyMap<HttpStack, StartedHttpTarget>;
  readonly agents: ReadonlyMap<HttpStack, Agent>;
  readonly samples: HttpComparisonSample[];
  readonly unavailable: HttpComparisonUnavailable[];
}): Promise<void> => {
  if (input.count === 0) return;
  const attempted = new Map<HttpStack, number>(
    HTTP_STACKS.map((stack) => [stack, 0]),
  );
  const body = JSON.stringify(
    input.metric === "http-valid" ? VALID_REQUEST : INVALID_REQUEST,
  );
  for (const stack of interleavedHttpStackSchedule(input.count, input.seed)) {
    const iteration = attempted.get(stack) ?? 0;
    attempted.set(stack, iteration + 1);
    const target = input.started.get(stack);
    const agent = input.agents.get(stack);
    if (target === undefined || agent === undefined) {
      input.unavailable.push(Object.freeze({
        metric: input.metric,
        stack,
        iteration,
        phase: input.phase,
        reason: "The HTTP target did not start.",
      }));
      continue;
    }
    try {
      const observation = await postJson(target.origin, agent, body);
      assertHttpContract(input.metric, observation);
      pushSample(input.samples, {
        metric: input.metric,
        stack,
        iteration,
        phase: input.phase,
        value: observation.nanoseconds,
        unit: "nanoseconds",
      });
    } catch (cause: unknown) {
      input.unavailable.push(Object.freeze({
        metric: input.metric,
        stack,
        iteration,
        phase: input.phase,
        reason: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }
};

const parseChildProbe = (text: string, stack: HttpStack): ChildProbe => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause: unknown) {
    throw new SyntaxError("HTTP comparison child returned invalid JSON.", { cause });
  }
  if (typeof value !== "object" || value === null ||
      Reflect.get(value, "schemaVersion") !== 1 ||
      Reflect.get(value, "kind") !== "http-comparison-child-probe" ||
      Reflect.get(value, "stack") !== stack) {
    throw new TypeError("HTTP comparison child returned the wrong identity.");
  }
  for (const key of ["coldReadyNanoseconds", "readyRssBytes"] as const) {
    const number = Reflect.get(value, key);
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
      throw new TypeError(`HTTP comparison child returned invalid ${key}.`);
    }
  }
  const maxRss = Reflect.get(value, "processMaxRssBytes");
  const maxReason = Reflect.get(value, "processMaxRssUnavailableReason");
  if (!(typeof maxRss === "number" && Number.isSafeInteger(maxRss) && maxRss > 0) &&
      !(maxRss === null && typeof maxReason === "string" && maxReason.length > 0)) {
    throw new TypeError("HTTP comparison child returned invalid maximum RSS evidence.");
  }
  return value as ChildProbe;
};

const runProcessProbes = async (input: {
  readonly root: string;
  readonly iterations: number;
  readonly seed: string;
  readonly samples: HttpComparisonSample[];
  readonly unavailable: HttpComparisonUnavailable[];
}): Promise<void> => {
  const attempted = new Map<HttpStack, number>(
    HTTP_STACKS.map((stack) => [stack, 0]),
  );
  const childPath = fileURLToPath(new URL("./child.js", import.meta.url));
  for (const stack of interleavedHttpStackSchedule(input.iterations, input.seed)) {
    const iteration = attempted.get(stack) ?? 0;
    attempted.set(stack, iteration + 1);
    let probe: ChildProbe;
    try {
      const result = await execFileAsync(process.execPath, [
        "--expose-gc",
        childPath,
        `--stack=${stack}`,
      ], {
        cwd: input.root,
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: 4 * 1_024 * 1_024,
      });
      probe = parseChildProbe(result.stdout.trim(), stack);
    } catch (cause: unknown) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      for (const metric of PROCESS_METRICS) {
        input.unavailable.push(Object.freeze({
          metric,
          stack,
          iteration,
          phase: "measured",
          reason,
        }));
      }
      continue;
    }
    pushSample(input.samples, {
      metric: "cold-ready",
      stack,
      iteration,
      phase: "measured",
      value: probe.coldReadyNanoseconds,
      unit: "nanoseconds",
    });
    pushSample(input.samples, {
      metric: "ready-rss",
      stack,
      iteration,
      phase: "measured",
      value: probe.readyRssBytes,
      unit: "bytes",
    });
    if (probe.processMaxRssBytes === null) {
      input.unavailable.push(Object.freeze({
        metric: "process-max-rss-ready",
        stack,
        iteration,
        phase: "measured",
        reason: probe.processMaxRssUnavailableReason ?? "Maximum RSS was unavailable.",
      }));
    } else {
      pushSample(input.samples, {
        metric: "process-max-rss-ready",
        stack,
        iteration,
        phase: "measured",
        value: probe.processMaxRssBytes,
        unit: "bytes",
      });
    }
  }
};

const summariesFor = (
  samples: readonly HttpComparisonSample[],
): readonly HttpComparisonSummary[] => {
  const summaries: HttpComparisonSummary[] = [];
  for (const metric of [...HTTP_METRICS, ...PROCESS_METRICS]) {
    for (const stack of HTTP_STACKS) {
      const matching = samples.filter((sample) =>
        sample.metric === metric && sample.stack === stack &&
        sample.phase === "measured"
      );
      if (matching.length === 0) continue;
      const unit = matching[0]!.unit;
      if (matching.some((sample) => sample.unit !== unit)) {
        throw new TypeError(`${metric}/${stack} mixes measurement units.`);
      }
      summaries.push(Object.freeze({
        metric,
        stack,
        unit,
        distribution: summarize(matching.map(({ value }) => value)),
      }));
    }
  }
  return Object.freeze(summaries);
};

export const runHttpFrameworkComparison = async (
  options: HttpComparisonOptions,
): Promise<HttpComparisonReport> => {
  const root = resolve(options.repositoryRoot);
  const seed = options.seed ?? "agentix-http-frameworks-exploratory-v1-2026-07-23";
  if (seed.length === 0) throw new TypeError("Comparison seed must be non-empty.");
  const warmups = nonNegativeSafeInteger(
    "warmupIterations",
    options.warmupIterations ?? 10,
  );
  const measured = positiveSafeInteger(
    "measuredIterations",
    options.measuredIterations ?? 100,
  );
  const processIterations = positiveSafeInteger(
    "processIterations",
    options.processIterations ?? 5,
  );
  const includeProcessMetrics = options.includeProcessMetrics !== false;
  const lockBytes = await readFile(resolve(root, "package-lock.json"));
  const lockValue: unknown = JSON.parse(lockBytes.toString("utf8"));
  const [gitCommit, gitStatus, sourceSha256] = await Promise.all([
    commandText(root, ["git", "rev-parse", "HEAD"]),
    commandText(root, ["git", "status", "--porcelain=v1"]),
    comparisonSourceHash(root),
  ]);
  const configuration = Object.freeze({
    warmupIterations: warmups,
    measuredIterations: measured,
    processIterations,
    processMetrics: includeProcessMetrics,
  });
  const samples: HttpComparisonSample[] = [];
  const unavailable: HttpComparisonUnavailable[] = [];
  const started = new Map<HttpStack, StartedHttpTarget>();
  const agents = new Map<HttpStack, Agent>();

  try {
    for (const target of TARGETS) {
      try {
        const running = await target.start();
        started.set(target.stack, running);
        agents.set(target.stack, new Agent({ keepAlive: true, maxSockets: 1 }));
      } catch (cause: unknown) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        for (const metric of HTTP_METRICS) {
          unavailable.push(Object.freeze({
            metric,
            stack: target.stack,
            iteration: null,
            phase: null,
            reason: `Target startup failed: ${reason}`,
          }));
        }
      }
    }

    for (const metric of HTTP_METRICS) {
      await runHotPhase({
        count: warmups,
        phase: "warmup",
        metric,
        seed: `${seed}:${metric}:warmup`,
        started,
        agents,
        samples,
        unavailable,
      });
      await runHotPhase({
        count: measured,
        phase: "measured",
        metric,
        seed: `${seed}:${metric}:measured`,
        started,
        agents,
        samples,
        unavailable,
      });
    }
  } finally {
    for (const agent of agents.values()) agent.destroy();
    await Promise.allSettled([...started.values()].map(({ close }) => close()));
  }

  if (includeProcessMetrics) {
    await runProcessProbes({
      root,
      iterations: processIterations,
      seed: `${seed}:process`,
      samples,
      unavailable,
    });
  } else {
    for (const metric of PROCESS_METRICS) {
      for (const stack of HTTP_STACKS) {
        unavailable.push(Object.freeze({
          metric,
          stack,
          iteration: null,
          phase: null,
          reason: "Fresh-process metrics were disabled by configuration.",
        }));
      }
    }
  }

  const cpu = cpus();
  const measurementPlanSha256 = hashJson({
    schemaVersion: 1,
    classification: "exploratory",
    stacks: HTTP_STACKS,
    metrics: [...HTTP_METRICS, ...PROCESS_METRICS],
    configuration,
    endpoint: {
      method: "POST",
      path: "/echo",
      client: "node:http keep-alive; one socket per stack",
      fullResponseConsumption: true,
    },
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "agentix-http-framework-comparison",
    classification: "exploratory",
    eligibleForConfirmatoryUse: false,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    seed,
    configuration,
    environment: Object.freeze({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpuModel: cpu[0]?.model ?? "unknown",
      cpuCount: cpu.length,
      totalMemoryBytes: totalmem(),
    }),
    repository: Object.freeze({
      gitCommit,
      dirty: gitStatus === null || gitStatus.length > 0,
      packageLockSha256: sha256(lockBytes),
      comparisonSourceSha256: sourceSha256,
    }),
    dependencies: packageVersions(lockValue),
    measurementPlanSha256,
    samples: Object.freeze(samples),
    summaries: summariesFor(samples),
    unavailable: Object.freeze(unavailable),
    limitations: Object.freeze([
      "This exploratory microbenchmark is not evidence for the agent-maintenance hypothesis.",
      "NestJS uses Express underneath, so the Express and NestJS stacks are not independent.",
      "Loopback, JSON serialization, JIT, GC, thermal state, and host load can dominate small differences.",
      "A single echo route does not predict non-trivial application performance.",
    ]),
  });
};
