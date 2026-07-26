import { execFile, spawn } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { cpus, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { hashJson, sha256 } from "../evidence.js";
import { summarize } from "../statistics.js";
import { interleavedHttpStackSchedule } from "./schedule.js";
import { startTarget } from "./targets/registry.js";
import {
  INVALID_REQUEST,
  PARAM_ID,
  VALID_REQUEST,
  agentixParamResponse,
  agentixValidResponse,
  invalidResponse,
  paramResponse,
  validResponse,
} from "./targets/shared.js";
import {
  BATCH_CONCURRENCY,
  HTTP_CONDITIONS,
  HTTP_STACKS,
  type HttpComparisonMetric,
  type HttpComparisonPhase,
  type HttpComparisonReport,
  type HttpComparisonSample,
  type HttpComparisonSummary,
  type HttpComparisonUnavailable,
  type HttpCondition,
  type HttpStack,
  type HttpWorkload,
  type StartedHttpTarget,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** v2 seed lineage: deliberately NO v1 ancestry (method change). */
export const DEFAULT_HTTP_COMPARISON_SEED =
  "agentix-http-frameworks-exploratory-v2-2026-07-26";

const V1_RESULT_FILE =
  "benchmarks/results/http-frameworks-exploratory-v1-2026-07-23.json";

const PROCESS_METRICS = [
  "cold-ready",
  "ready-rss",
  "process-max-rss-ready",
] as const;

type HttpMetric = "http-valid" | "http-invalid" | "http-param" | "http-batch";

interface WorkloadSpec {
  readonly metric: HttpMetric;
  readonly workload: HttpWorkload;
  readonly concurrency: number;
  readonly request: string;
}

const WORKLOADS: readonly WorkloadSpec[] = Object.freeze([
  {
    metric: "http-valid",
    workload: "echo-valid",
    concurrency: 1,
    request: "POST /echo with the valid echo body",
  },
  {
    metric: "http-invalid",
    workload: "echo-invalid",
    concurrency: 1,
    request: "POST /echo with the invalid echo body",
  },
  {
    metric: "http-param",
    workload: "param-get",
    concurrency: 1,
    request: `GET /items/${PARAM_ID}`,
  },
  {
    metric: "http-batch",
    workload: "echo-batch",
    concurrency: BATCH_CONCURRENCY,
    request:
      `${BATCH_CONCURRENCY} concurrent keep-alive POST /echo valid requests; ` +
      "one sample = full batch completion",
  },
]);

const HTTP_METRICS: readonly HttpMetric[] = Object.freeze(
  WORKLOADS.map(({ metric }) => metric),
);

export interface HttpComparisonOptions {
  readonly repositoryRoot: string;
  readonly seed?: string;
  readonly warmupIterations?: number;
  readonly measuredIterations?: number;
  readonly processIterations?: number;
  readonly includeProcessMetrics?: boolean;
  /**
   * Run every target in its own child process (RECOMMENDED). The in-process
   * default shares one event loop between all servers and the client, which
   * inflated the v1 cross-stack gap roughly tenfold.
   */
  readonly isolated?: boolean;
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
    zod: version("node_modules/zod"),
  });
};

const requestJson = (
  origin: string,
  agent: Agent,
  input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: string;
  },
): Promise<HttpObservation> => new Promise((resolveObservation, reject) => {
  const startedAt = process.hrtime.bigint();
  const headers: Record<string, string | number> = {};
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(input.body);
  }
  const request = httpRequest(new URL(input.path, origin), {
    method: input.method,
    agent,
    headers,
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
  request.end(input.body);
});

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const isAgentixInvalidInput = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  if ((body as Record<string, unknown>)["ok"] !== false) return false;
  const error = (body as Record<string, unknown>)["error"];
  return typeof error === "object" && error !== null &&
    (error as Record<string, unknown>)["code"] === "INVALID_INPUT";
};

/**
 * Per-stack contracts: Express/NestJS keep the v1 envelope byte-for-byte in
 * the default condition; Agentix v2 serves its adapter's fixed envelope
 * ({ok:true,value} / {ok:false,error:{code,...}}).
 */
const assertWorkloadContract = (
  workload: HttpWorkload,
  stack: HttpStack,
  observation: HttpObservation,
): void => {
  const agentix = stack === "agentix-node";
  let matched = false;
  let expectedStatus = 200;
  switch (workload) {
    case "echo-valid":
    case "echo-batch":
      matched = observation.status === 200 && sameJson(
        observation.body,
        agentix
          ? agentixValidResponse(VALID_REQUEST.value)
          : validResponse(VALID_REQUEST.value),
      );
      break;
    case "echo-invalid":
      expectedStatus = 400;
      matched = observation.status === 400 && (agentix
        ? isAgentixInvalidInput(observation.body)
        : sameJson(observation.body, invalidResponse()));
      break;
    case "param-get":
      matched = observation.status === 200 && sameJson(
        observation.body,
        agentix ? agentixParamResponse(PARAM_ID) : paramResponse(PARAM_ID),
      );
      break;
  }
  if (!matched ||
      !observation.contentType.toLowerCase().startsWith("application/json")) {
    throw new Error(
      `${workload}/${stack} contract mismatch (expected ${expectedStatus}): ` +
      `status=${observation.status} content-type=${observation.contentType} ` +
      `body=${JSON.stringify(observation.body)}`,
    );
  }
};

const runWorkloadOnce = async (
  spec: WorkloadSpec,
  stack: HttpStack,
  origin: string,
  agent: Agent,
): Promise<number> => {
  if (spec.workload === "echo-batch") {
    const body = JSON.stringify(VALID_REQUEST);
    const startedAt = process.hrtime.bigint();
    const observations = await Promise.all(Array.from(
      { length: spec.concurrency },
      () => requestJson(origin, agent, { method: "POST", path: "/echo", body }),
    ));
    const nanoseconds = Number(process.hrtime.bigint() - startedAt);
    for (const observation of observations) {
      assertWorkloadContract(spec.workload, stack, observation);
    }
    return nanoseconds;
  }
  const request = spec.workload === "param-get"
    ? { method: "GET" as const, path: `/items/${PARAM_ID}` }
    : {
        method: "POST" as const,
        path: "/echo",
        body: JSON.stringify(
          spec.workload === "echo-valid" ? VALID_REQUEST : INVALID_REQUEST,
        ),
      };
  const observation = await requestJson(origin, agent, request);
  assertWorkloadContract(spec.workload, stack, observation);
  return observation.nanoseconds;
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

const runWorkloadPhase = async (input: {
  readonly count: number;
  readonly phase: HttpComparisonPhase;
  readonly spec: WorkloadSpec;
  readonly condition: HttpCondition;
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
  for (const stack of interleavedHttpStackSchedule(input.count, input.seed)) {
    const iteration = attempted.get(stack) ?? 0;
    attempted.set(stack, iteration + 1);
    const target = input.started.get(stack);
    const agent = input.agents.get(stack);
    if (target === undefined || agent === undefined) {
      input.unavailable.push(Object.freeze({
        metric: input.spec.metric,
        stack,
        condition: input.condition,
        iteration,
        phase: input.phase,
        reason: "The HTTP target did not start.",
      }));
      continue;
    }
    try {
      const nanoseconds = await runWorkloadOnce(
        input.spec,
        stack,
        target.origin,
        agent,
      );
      pushSample(input.samples, {
        metric: input.spec.metric,
        stack,
        condition: input.condition,
        workload: input.spec.workload,
        concurrency: input.spec.concurrency,
        iteration,
        phase: input.phase,
        value: nanoseconds,
        unit: "nanoseconds",
      });
    } catch (cause: unknown) {
      input.unavailable.push(Object.freeze({
        metric: input.spec.metric,
        stack,
        condition: input.condition,
        iteration,
        phase: input.phase,
        reason: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }
};

const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_KILL_TIMEOUT_MS = 5_000;

/**
 * Isolated mode: the target runs in its own child process; only the measuring
 * client stays in this process, so requests cross real loopback sockets
 * between two processes.
 */
const startIsolatedTarget = (
  stack: HttpStack,
  condition: HttpCondition,
): Promise<StartedHttpTarget> => new Promise((resolveStart, rejectStart) => {
  const childPath = fileURLToPath(new URL("./server-child.js", import.meta.url));
  const child = spawn(process.execPath, [
    childPath,
    `--stack=${stack}`,
    `--condition=${condition}`,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    child.kill("SIGKILL");
    rejectStart(error);
  };
  timeout = setTimeout(() => {
    fail(new Error(
      `Isolated ${stack}/${condition} server did not report readiness within ` +
      `${SERVER_READY_TIMEOUT_MS}ms.`,
    ));
  }, SERVER_READY_TIMEOUT_MS);
  child.once("error", fail);
  const onEarlyExit = (code: number | null): void => {
    fail(new Error(
      `Isolated ${stack}/${condition} server exited before readiness ` +
      `(code ${String(code)}): ${stderrBuffer.trim().slice(0, 1_000)}`,
    ));
  };
  child.once("exit", onEarlyExit);
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (settled) return;
    stdoutBuffer += chunk.toString();
    const newline = stdoutBuffer.indexOf("\n");
    if (newline === -1) return;
    const line = stdoutBuffer.slice(0, newline);
    let ready: unknown;
    try {
      ready = JSON.parse(line);
    } catch {
      fail(new Error(
        `Isolated ${stack}/${condition} server printed an invalid ready line: ${line}`,
      ));
      return;
    }
    if (typeof ready !== "object" || ready === null ||
        Reflect.get(ready, "kind") !== "http-comparison-server-ready" ||
        Reflect.get(ready, "stack") !== stack ||
        Reflect.get(ready, "condition") !== condition ||
        typeof Reflect.get(ready, "origin") !== "string") {
      fail(new Error(
        `Isolated ${stack}/${condition} server reported the wrong identity: ${line}`,
      ));
      return;
    }
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    child.off("exit", onEarlyExit);
    const close = (): Promise<void> => new Promise((resolveClose) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveClose();
        return;
      }
      const killTimer = setTimeout(
        () => child.kill("SIGKILL"),
        SERVER_KILL_TIMEOUT_MS,
      );
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolveClose();
      });
      child.kill("SIGTERM");
    });
    resolveStart(Object.freeze({
      stack,
      origin: Reflect.get(ready, "origin") as string,
      close,
    }));
  });
});

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
          condition: "default" as const,
          iteration,
          phase: "measured" as const,
          reason,
        }));
      }
      continue;
    }
    const processSample = (
      metric: (typeof PROCESS_METRICS)[number],
      value: number,
      unit: "nanoseconds" | "bytes",
    ): void => pushSample(input.samples, {
      metric,
      stack,
      condition: "default",
      workload: null,
      concurrency: null,
      iteration,
      phase: "measured",
      value,
      unit,
    });
    processSample("cold-ready", probe.coldReadyNanoseconds, "nanoseconds");
    processSample("ready-rss", probe.readyRssBytes, "bytes");
    if (probe.processMaxRssBytes === null) {
      input.unavailable.push(Object.freeze({
        metric: "process-max-rss-ready" as const,
        stack,
        condition: "default" as const,
        iteration,
        phase: "measured" as const,
        reason: probe.processMaxRssUnavailableReason ?? "Maximum RSS was unavailable.",
      }));
    } else {
      processSample("process-max-rss-ready", probe.processMaxRssBytes, "bytes");
    }
  }
};

const summariesFor = (
  samples: readonly HttpComparisonSample[],
): readonly HttpComparisonSummary[] => {
  const summaries: HttpComparisonSummary[] = [];
  const metrics: readonly HttpComparisonMetric[] = [
    ...HTTP_METRICS,
    ...PROCESS_METRICS,
  ];
  for (const metric of metrics) {
    for (const stack of HTTP_STACKS) {
      for (const condition of HTTP_CONDITIONS) {
        const matching = samples.filter((sample) =>
          sample.metric === metric && sample.stack === stack &&
          sample.condition === condition && sample.phase === "measured"
        );
        if (matching.length === 0) continue;
        const first = matching[0]!;
        if (matching.some((sample) => sample.unit !== first.unit)) {
          throw new TypeError(`${metric}/${stack}/${condition} mixes measurement units.`);
        }
        const distribution = summarize(matching.map(({ value }) => value));
        summaries.push(Object.freeze({
          metric,
          stack,
          condition,
          workload: first.workload,
          concurrency: first.concurrency,
          unit: first.unit,
          distribution,
          ...(metric === "http-batch"
            ? {
                requestsPerSecond:
                  (BATCH_CONCURRENCY * 1_000_000_000) / distribution.median,
              }
            : {}),
        }));
      }
    }
  }
  return Object.freeze(summaries);
};

export const runHttpFrameworkComparison = async (
  options: HttpComparisonOptions,
): Promise<HttpComparisonReport> => {
  const root = resolve(options.repositoryRoot);
  const seed = options.seed ?? DEFAULT_HTTP_COMPARISON_SEED;
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
  const isolated = options.isolated === true;
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
    isolatedProcesses: isolated,
    batchConcurrency: BATCH_CONCURRENCY,
    conditions: HTTP_CONDITIONS,
  });
  const samples: HttpComparisonSample[] = [];
  const unavailable: HttpComparisonUnavailable[] = [];

  for (const condition of HTTP_CONDITIONS) {
    const started = new Map<HttpStack, StartedHttpTarget>();
    const agents = new Map<HttpStack, Agent>();
    try {
      for (const stack of HTTP_STACKS) {
        try {
          const running = isolated
            ? await startIsolatedTarget(stack, condition)
            : await startTarget(stack, condition);
          started.set(stack, running);
          agents.set(stack, new Agent({
            keepAlive: true,
            maxSockets: BATCH_CONCURRENCY,
          }));
        } catch (cause: unknown) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          for (const metric of HTTP_METRICS) {
            unavailable.push(Object.freeze({
              metric,
              stack,
              condition,
              iteration: null,
              phase: null,
              reason: `Target startup failed: ${reason}`,
            }));
          }
        }
      }

      for (const spec of WORKLOADS) {
        await runWorkloadPhase({
          count: warmups,
          phase: "warmup",
          spec,
          condition,
          seed: `${seed}:${condition}:${spec.metric}:warmup`,
          started,
          agents,
          samples,
          unavailable,
        });
        await runWorkloadPhase({
          count: measured,
          phase: "measured",
          spec,
          condition,
          seed: `${seed}:${condition}:${spec.metric}:measured`,
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
          condition: "default" as const,
          iteration: null,
          phase: null,
          reason: "Fresh-process metrics were disabled by configuration.",
        }));
      }
    }
  }

  const processIsolation = isolated
    ? ("per-target-child-process" as const)
    : ("in-process-shared-event-loop" as const);
  const cpu = cpus();
  const measurementPlanSha256 = hashJson({
    schemaVersion: 2,
    classification: "exploratory",
    methodology: "v2",
    processIsolation,
    stacks: HTTP_STACKS,
    conditions: HTTP_CONDITIONS,
    metrics: [...HTTP_METRICS, ...PROCESS_METRICS],
    workloads: WORKLOADS,
    configuration,
    client:
      "node:http keep-alive; one agent per stack per condition; " +
      `maxSockets=${BATCH_CONCURRENCY}; full response consumption`,
  });
  return Object.freeze({
    schemaVersion: 2,
    kind: "agentix-http-framework-comparison",
    classification: "exploratory",
    eligibleForConfirmatoryUse: false,
    methodology: Object.freeze({
      version: "v2" as const,
      processIsolation,
      recommendedProcessIsolation: "per-target-child-process" as const,
      supersedes:
        `${V1_RESULT_FILE} (methodology change; v1 and v2 values are not comparable)`,
      changesFromV1: Object.freeze([
        "The Agentix target uses the v2 API (feature()/command()) served by the serveNode raw host; the v1 target's redundant mapResponse output re-validation is removed.",
        "Optional per-target child-process isolation (--isolated, recommended): the v1 shared-event-loop method ran all servers plus the client on one event loop and inflated the Agentix-vs-Express gap roughly tenfold.",
        "A second 'validated' condition gives Express and NestJS zod input+output validation, matching the boundary work Agentix always performs; the default condition keeps their v1 behavior byte-identical.",
        `New workloads: GET /items/${PARAM_ID} param route and a ${BATCH_CONCURRENCY}-in-flight keep-alive echo batch with derived requests-per-second.`,
        "New seed lineage without v1 ancestry; every sample is labeled with condition, workload, and concurrency.",
      ]),
    }),
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
      "Echo-scale routes do not predict non-trivial application performance.",
      ...(isolated
        ? []
        : [
            "IN-PROCESS METHOD: all servers and the measuring client share one event loop; the v1 corpus showed this inflates cross-stack gaps roughly tenfold. Prefer --isolated.",
          ]),
    ]),
  });
};
