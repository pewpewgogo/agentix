/**
 * Corpus v2 dry-run: engineering validation only, never confirmatory evidence.
 *
 * Without invoking any paid model this script demonstrates, for every task/arm
 * of `agentix-commerce-maintenance-v2`:
 *
 *   A. the frozen corpus loads and every fixture arm materializes from the
 *      pinned commit with its defect overlays and without embedded solutions;
 *   B. the task-specific acceptance behavior FAILS on the unmodified fixture
 *      (executed for real, in-process against the materialized application),
 *      proving each task demands an actual maintenance change;
 *   C. the fixtures start green: the real per-arm regression suites pass on a
 *      clean arm and on both injected-defect arms;
 *   D. the harness executes a full smoke lifecycle per arm and writes a
 *      well-formed immutable record that is machine-labeled non-evidence
 *      (finalSuccess=false, invalidRunReason=production_hidden_evaluator_unavailable).
 *
 * Usage: tsx src/dry-run-v2.ts <repositoryRoot> [--out <reportPath>]
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  HARNESS_SCHEMA_VERSION,
  ScriptedAgentAdapter,
  readImmutableRunResult,
  runBenchmark,
} from "../../harness/src/index.js";
import {
  createEvaluatorLifecycleHooks,
  type AnswerDriver,
  type BlackBoxDriver,
  type ConfinedProcessRunner,
  type ProcessRequest,
} from "./executor.js";
import { loadCorpus, type LoadedTask } from "./load.js";
import { materializeFixture } from "./materialize.js";
import type { Implementation } from "./schemas.js";

const execFileAsync = promisify(execFile);

interface CheckOutcome {
  readonly name: string;
  readonly status: "passed" | "failed" | "not_applicable";
  readonly details: string;
}

const checks: CheckOutcome[] = [];
const record = (
  name: string,
  ok: boolean | null,
  details: string,
): void => {
  checks.push({
    name,
    status: ok === null ? "not_applicable" : ok ? "passed" : "failed",
    details,
  });
  const label = ok === null ? "n/a " : ok ? "ok  " : "FAIL";
  process.stdout.write(`[${label}] ${name}: ${details}\n`);
};

const parseArguments = (): { readonly root: string; readonly out: string | null } => {
  const positional: string[] = [];
  let out: string | null = null;
  const values = process.argv.slice(2);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (value === "--out") {
      out = values[index + 1] ?? null;
      index += 1;
      continue;
    }
    positional.push(value);
  }
  return { root: resolve(positional[0] ?? "."), out };
};

const { root: repositoryRoot, out: outputPath } = parseArguments();
const dryRunRoot = join(repositoryRoot, "benchmarks/.workspaces/corpus-v2-dryrun");
const fixturesRoot = join(dryRunRoot, "fixtures");
const runsRoot = join(dryRunRoot, "runs");
const resultsRoot = join(dryRunRoot, "results");

// ------------------------------------------------------------------ helpers

interface CommerceSystemLike {
  handle(request: Request): Promise<Response>;
  snapshot(): Promise<unknown>;
}

type SystemFactory = (options?: Record<string, unknown>) => CommerceSystemLike;

const loadSystemFactory = async (
  workspacePath: string,
  implementation: Implementation,
): Promise<SystemFactory> => {
  if (implementation === "framework") {
    const module = (await import(
      pathToFileURL(join(workspacePath, "examples/framework-app/src/application.ts")).href
    )) as { createFrameworkSystem: SystemFactory };
    return (options) => module.createFrameworkSystem(options);
  }
  const module = (await import(
    pathToFileURL(join(workspacePath, "examples/plain-app/src/system.ts")).href
  )) as { createPlainSystem: SystemFactory };
  return (options) => module.createPlainSystem(options);
};

interface HttpProbeResult {
  readonly status: number;
  readonly body: {
    readonly ok?: boolean;
    readonly value?: Record<string, unknown> | readonly Record<string, unknown>[];
    readonly error?: { readonly code?: string };
  } | null;
}

const send = async (
  system: CommerceSystemLike,
  method: string,
  path: string,
  permissions: string,
  body?: unknown,
): Promise<HttpProbeResult> => {
  const response = await system.handle(
    new Request(`http://commerce.invalid${path}`, {
      method,
      headers: {
        "x-principal-id": "dry-run-principal",
        "x-permissions": permissions,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  let parsed: HttpProbeResult["body"] = null;
  try {
    parsed = (await response.json()) as HttpProbeResult["body"];
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
};

const deterministicOptions = (): Record<string, unknown> => ({
  now: () => "2036-01-01T00:00:00.000Z",
  paymentOutcomes: ["approved", "approved", "approved", "approved"],
});

const seedCustomer = (system: CommerceSystemLike) =>
  send(system, "POST", "/customers", "customers:create", { id: "customer-1", name: "Ada" });
const seedProduct = (system: CommerceSystemLike, stock = 10) =>
  send(system, "POST", "/products", "products:create", {
    id: "product-1",
    name: "Engine",
    unitPriceCents: 1_000,
    stock,
  });
const placeOrder = (system: CommerceSystemLike, quantity = 1) =>
  send(system, "POST", "/orders", "orders:create", {
    customerId: "customer-1",
    productId: "product-1",
    quantity,
  });

interface ProbeOutcome {
  /** Whether the requested post-change acceptance behavior held. */
  readonly accepted: boolean | null;
  readonly details: string;
}

/**
 * Each probe executes the task's requested behavior against the UNMODIFIED
 * fixture. It must come back `accepted: false` before the maintenance change.
 */
const probes: Record<
  string,
  (factory: SystemFactory, workspacePath: string) => Promise<ProbeOutcome>
> = {
  "task-01-simple-feature": async (factory) => {
    const system = factory(deterministicOptions());
    const created = await send(system, "POST", "/promotions", "promotions:create", {
      code: "Save10",
      percentOff: 10,
    });
    const fetched = await send(system, "GET", "/promotions/save10", "promotions:read");
    const accepted =
      created.status === 201 &&
      fetched.status === 200 &&
      (fetched.body?.value as { code?: string } | undefined)?.code === "SAVE10";
    return {
      accepted,
      details: `POST /promotions -> ${created.status}; GET /promotions/save10 -> ${fetched.status}`,
    };
  },
  "task-02-field-propagation": async (factory) => {
    const system = factory(deterministicOptions());
    const created = await send(system, "POST", "/products", "products:create", {
      id: "product-desc",
      name: "Widget",
      unitPriceCents: 500,
      stock: 3,
      description: "  Fancy  ",
    });
    const fetched = await send(system, "GET", "/products/product-desc", "products:read");
    const createdDescription =
      (created.body?.value as { description?: string } | undefined)?.description;
    const fetchedDescription =
      (fetched.body?.value as { description?: string } | undefined)?.description;
    const accepted =
      created.status === 201 &&
      createdDescription === "Fancy" &&
      fetchedDescription === "Fancy";
    return {
      accepted,
      details: `create -> ${created.status} description=${JSON.stringify(createdDescription)}; read description=${JSON.stringify(fetchedDescription)}`,
    };
  },
  "task-03-cross-feature-rule": async (factory) => {
    const system = factory(deterministicOptions());
    await seedCustomer(system);
    await seedProduct(system);
    const first = await placeOrder(system);
    const repeat = await placeOrder(system);
    const accepted =
      first.status === 201 &&
      repeat.status === 409 &&
      repeat.body?.error?.code === "REPEAT_PURCHASE";
    return {
      accepted,
      details: `first order -> ${first.status}; repeat order -> ${repeat.status} ${repeat.body?.error?.code ?? "no code"}`,
    };
  },
  "task-04-external-adapter": async (factory) => {
    const system = factory({
      ...deterministicOptions(),
      fraudDecisions: ["blocked"],
    });
    await seedCustomer(system);
    await seedProduct(system);
    const blocked = await placeOrder(system);
    const accepted =
      blocked.status === 409 && blocked.body?.error?.code === "FRAUD_REJECTED";
    return {
      accepted,
      details: `blocked-decision order -> ${blocked.status} ${blocked.body?.error?.code ?? "no code"}`,
    };
  },
  "task-05-localized-defect": async (factory) => {
    const system = factory(deterministicOptions());
    const exact80 = await send(system, "POST", "/products", "products:create", {
      id: "product-80",
      name: "a".repeat(80),
      unitPriceCents: 100,
      stock: 1,
    });
    const over81 = await send(system, "POST", "/products", "products:create", {
      id: "product-81",
      name: "a".repeat(81),
      unitPriceCents: 100,
      stock: 1,
    });
    const accepted = exact80.status === 201 && over81.status === 400;
    return {
      accepted,
      details: `80-char name -> ${exact80.status}; 81-char name -> ${over81.status}`,
    };
  },
  "task-06-misleading-symptom": async (factory) => {
    const system = factory(deterministicOptions());
    await seedCustomer(system);
    await seedProduct(system);
    const order = await placeOrder(system, 7);
    const events = await send(system, "GET", "/events", "events:read");
    const list = Array.isArray(events.body?.value) ? events.body.value : [];
    const found = list.some(
      (event) => (event as { data?: { quantity?: number } }).data?.quantity === 7,
    );
    const accepted = order.status === 201 && events.status === 200 && found;
    return {
      accepted,
      details: `quantity-7 order -> ${order.status}; events -> ${events.status}; order.created present=${String(found)}`,
    };
  },
  "task-07-authorization-change": async (factory) => {
    const system = factory(deterministicOptions());
    const catalogWrite = await send(system, "POST", "/products", "catalog:write", {
      id: "product-auth",
      name: "Engine",
      unitPriceCents: 100,
      stock: 1,
    });
    const accepted = catalogWrite.status === 201;
    return {
      accepted,
      details: `catalog:write-only create -> ${catalogWrite.status}`,
    };
  },
  "task-08-schema-migration": async (_factory, workspacePath) => {
    try {
      await execFileAsync(
        "npm",
        [
          "run",
          "migrate:products",
          "--",
          "--input",
          "migration-inputs/products.v1.json",
          "--output",
          "migration-output.json",
        ],
        { cwd: workspacePath, timeout: 60_000 },
      );
      return { accepted: true, details: "npm run migrate:products exited 0" };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      return { accepted: false, details: `npm run migrate:products failed (${detail ?? "error"})` };
    }
  },
  "task-09-compatible-rename": async (factory) => {
    const system = factory(deterministicOptions());
    await seedCustomer(system);
    await seedProduct(system);
    const purchase = await send(system, "POST", "/purchases", "orders:create", {
      customerId: "customer-1",
      productId: "product-1",
      quantity: 1,
    });
    const accepted = purchase.status === 201;
    return { accepted, details: `POST /purchases -> ${purchase.status}` };
  },
  "task-10-architecture-question": async () => ({
    accepted: null,
    details:
      "read-only answer task: no pre-change failing acceptance applies; the answer evaluator fails closed without a production driver",
  }),
};

// ---------------------------------------------------------- smoke doubles

/** Structural smoke double; its attestation is smoke-only, never confirmatory. */
class SmokeOnlyConfinedRunner implements ConfinedProcessRunner {
  public readonly smokeOnly = true;
  public readonly isolation = {
    network: "disabled" as const,
    filesystem: "workspace-only" as const,
  };
  public readonly requests: ProcessRequest[] = [];

  public async run(request: ProcessRequest) {
    this.requests.push(request);
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  }
}

const smokeBlackBoxDriver: BlackBoxDriver = {
  async run() {
    return { passed: true, details: "smoke-only driver invocation" };
  },
};

const smokeAnswerDriver: AnswerDriver = {
  async run() {
    return { passed: true, details: "smoke-only answer rubric invocation" };
  },
};

// ------------------------------------------------------------------- phases

const DEFECT_ANCHORS: Record<string, Record<Implementation, readonly string[]>> = {
  "task-05-localized-defect": {
    framework: ["max: 79"],
    plain: [".max(79)"],
  },
  "task-06-misleading-symptom": {
    framework: ["order.quantity <= 6"],
    plain: ["commit.order.quantity <= 6"],
  },
};

const SOLUTION_MARKERS = [
  "/promotions",
  "REPEAT_PURCHASE",
  "FRAUD_REJECTED",
  "catalog:write",
  "migrate:products",
  "/purchases",
] as const;

const DEFECT_FILES: Record<string, Record<Implementation, string>> = {
  "task-05-localized-defect": {
    framework: "examples/framework-app/src/features/products.ts",
    plain: "examples/plain-app/src/features/products/product.ts",
  },
  "task-06-misleading-symptom": {
    framework: "examples/framework-app/src/adapters.ts",
    plain: "examples/plain-app/src/infrastructure/memory.ts",
  },
};

const APP_SOURCE_DIRECTORIES: Record<Implementation, string> = {
  framework: "examples/framework-app/src",
  plain: "examples/plain-app/src",
};

const readAppSources = async (
  workspacePath: string,
  implementation: Implementation,
): Promise<string> => {
  const { readdir } = await import("node:fs/promises");
  const rootDirectory = join(workspacePath, APP_SOURCE_DIRECTORIES[implementation]);
  const contents: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        contents.push(await readFile(absolute, "utf8"));
      }
    }
  };
  await visit(rootDirectory);
  return contents.join("\n");
};

const runRegression = async (
  workspacePath: string,
  implementation: Implementation,
): Promise<{ readonly passed: boolean; readonly details: string }> => {
  const applicationDirectory =
    implementation === "framework" ? "examples/framework-app" : "examples/plain-app";
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(repositoryRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        workspacePath,
        applicationDirectory,
        "examples/shared-contract",
      ],
      { cwd: repositoryRoot, timeout: 480_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const summary = stdout.split("\n").find((line) => line.includes("Tests")) ?? "passed";
    return { passed: true, details: summary.trim() };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.slice(0, 400) : String(error);
    return { passed: false, details: detail };
  }
};

const main = async (): Promise<void> => {
  await rm(dryRunRoot, { recursive: true, force: true });
  await mkdir(fixturesRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await mkdir(resultsRoot, { recursive: true });

  const corpus = await loadCorpus(repositoryRoot, "v2");
  record(
    "corpus-load",
    corpus.tasks.length === 10,
    `${corpus.lock.corpusId}@${corpus.lock.corpusVersion}: ${corpus.tasks.length} tasks, ${corpus.tasks.length * 2} fixture arms hash-verified`,
  );

  const workspaceByArm = new Map<string, string>();
  for (const task of corpus.tasks) {
    for (const implementation of ["framework", "plain"] as const) {
      const armName = `${task.specification.id}-${implementation}`;
      const destination = join(fixturesRoot, armName);
      const result = await materializeFixture(
        repositoryRoot,
        destination,
        task.arms[implementation].fixture,
      );
      workspaceByArm.set(armName, destination);
      record(
        `materialize:${armName}`,
        result.files.length > 0,
        `${result.files.length} files from the frozen ${corpus.configuration.version} inventory + overlays`,
      );

      const anchors = DEFECT_ANCHORS[task.specification.id]?.[implementation];
      if (anchors !== undefined) {
        const defectFile = DEFECT_FILES[task.specification.id]?.[implementation];
        const content = await readFile(join(destination, defectFile ?? ""), "utf8");
        const present = anchors.every((anchor) => content.includes(anchor));
        record(
          `defect-overlay:${armName}`,
          present,
          `expected defect anchor(s) ${anchors.join(", ")} in ${defectFile ?? "unknown"}`,
        );
      }
    }
  }

  // Solution-absence audit over one clean arm per implementation.
  for (const implementation of ["framework", "plain"] as const) {
    const workspace = workspaceByArm.get(`task-01-simple-feature-${implementation}`);
    if (workspace === undefined) throw new Error("Clean arm workspace missing.");
    const sources = await readAppSources(workspace, implementation);
    const leaked = SOLUTION_MARKERS.filter((marker) => sources.includes(marker));
    record(
      `solution-absence:${implementation}`,
      leaked.length === 0,
      leaked.length === 0
        ? `none of ${SOLUTION_MARKERS.join(", ")} present in the starting application`
        : `leaked solution markers: ${leaked.join(", ")}`,
    );
  }

  // Phase B: pre-change acceptance probes must FAIL on the unmodified fixture.
  const probeResults: Record<string, Record<string, ProbeOutcome>> = {};
  for (const task of corpus.tasks) {
    const probe = probes[task.specification.id];
    if (probe === undefined) throw new Error(`No probe for ${task.specification.id}.`);
    probeResults[task.specification.id] = {};
    for (const implementation of ["framework", "plain"] as const) {
      const armName = `${task.specification.id}-${implementation}`;
      const workspace = workspaceByArm.get(armName);
      if (workspace === undefined) throw new Error(`Workspace missing for ${armName}.`);
      const factory = await loadSystemFactory(workspace, implementation);
      const outcome = await probe(factory, workspace);
      const probeRow = probeResults[task.specification.id];
      if (probeRow !== undefined) probeRow[implementation] = outcome;
      record(
        `pre-change-acceptance:${armName}`,
        outcome.accepted === null ? null : outcome.accepted === false,
        outcome.accepted === null
          ? outcome.details
          : `requested behavior ${outcome.accepted ? "UNEXPECTEDLY ALREADY PRESENT" : "absent as required"} (${outcome.details})`,
      );
    }
  }

  // Phase C: the real regression suites stay green on clean and defect arms.
  for (const taskId of [
    "task-01-simple-feature",
    "task-05-localized-defect",
    "task-06-misleading-symptom",
  ]) {
    for (const implementation of ["framework", "plain"] as const) {
      const armName = `${taskId}-${implementation}`;
      const workspace = workspaceByArm.get(armName);
      if (workspace === undefined) throw new Error(`Workspace missing for ${armName}.`);
      const regression = await runRegression(workspace, implementation);
      record(`baseline-regression:${armName}`, regression.passed, regression.details);
    }
  }

  // Phase D: harness smoke lifecycle + immutable non-evidence records.
  const smokeRecords: Record<string, unknown>[] = [];
  for (const task of corpus.tasks) {
    for (const implementation of ["framework", "plain"] as const) {
      const armName = `${task.specification.id}-${implementation}`;
      const runId = `corpus-v2-dryrun-${armName}`;
      const loadedTask: LoadedTask = task;
      const hooks = createEvaluatorLifecycleHooks({
        task: loadedTask,
        implementation,
        mode: "smoke",
        allowedRunsRoot: runsRoot,
        processRunner: new SmokeOnlyConfinedRunner(),
        commandTimeoutMs: 1_000,
        blackBoxDriver: smokeBlackBoxDriver,
        answerDriver: smokeAnswerDriver,
        answerProvider: async () =>
          "smoke placeholder answer: engineering validation only, not an agent response",
      });
      const output = await runBenchmark({
        mode: "smoke",
        identity: {
          schemaVersion: HARNESS_SCHEMA_VERSION,
          runId,
          task: {
            schemaVersion: HARNESS_SCHEMA_VERSION,
            id: task.specification.id,
            version: task.specification.version,
          },
          arm: implementation,
          repetition: 1,
          scheduleSeed: "corpus-v2-dryrun-not-a-schedule",
          fixtureRevision: task.specification.fixture[implementation].sha256,
          evaluatorRevision: task.specification.evaluator.hiddenManifestSha256,
          analysisRevision: "not-applicable-smoke-v2",
        },
        fixture: { fixturesRoot, relativePath: armName },
        workspaceRunsRoot: runsRoot,
        resultsRoot,
        instructions: {
          system: "Local deterministic corpus v2 dry-run. No provider calls.",
          developer: "Use only the scripted adapter and injected smoke doubles.",
          user: task.specification.userRequest,
          tools: [],
          permissions: { network: false },
          limits: { seconds: 5 },
        },
        adapter: new ScriptedAgentAdapter({
          id: "corpus-v2-dryrun-smoke",
          steps: [],
        }),
        hooks,
        timeoutMs: 10_000,
        pricing: null,
        environment: {
          containerImage: null,
          hostClass: "local-dry-run",
          packageManager: "npm-offline-smoke",
          dependencyCachePolicy: "not-used-smoke-double",
          networkPolicy: "disabled",
          toolVersions: { node: process.version },
        },
      });
      const reread = await readImmutableRunResult(resultsRoot, runId);
      const wellFormed =
        output.record.completionStatus === "completed" &&
        output.record.finalSuccess === false &&
        output.record.evaluation.invalidRunReason ===
          "production_hidden_evaluator_unavailable" &&
        output.record.preflight.length ===
          task.arms[implementation].fixture.preflight.length &&
        output.record.preflight.every(({ status }) => status === "passed") &&
        reread.finalSuccess === false &&
        reread.mode === "smoke";
      smokeRecords.push({
        runId,
        completionStatus: output.record.completionStatus,
        finalSuccess: output.record.finalSuccess,
        invalidRunReason: output.record.evaluation.invalidRunReason,
        resultDirectory: output.runDirectory,
      });
      record(
        `harness-smoke:${armName}`,
        wellFormed,
        `completionStatus=${output.record.completionStatus}, finalSuccess=${String(output.record.finalSuccess)}, invalidRunReason=${output.record.evaluation.invalidRunReason ?? "none"}`,
      );
    }
  }

  const failed = checks.filter(({ status }) => status === "failed");
  const report = {
    schemaVersion: 1,
    kind: "corpus-v2-dry-run",
    classification: "smoke-engineering-validation",
    evidence: "NOT-CONFIRMATORY: this record can never support a framework verdict",
    generatedAt: new Date().toISOString(),
    corpus: {
      id: corpus.lock.corpusId,
      version: corpus.lock.corpusVersion,
      taskCount: corpus.tasks.length,
      fixtureArmCount: corpus.tasks.length * 2,
    },
    adapters: {
      agent: "scripted (no provider, no paid model)",
      evaluatorProcessRunner: "smoke-only structural double for harness records",
      preChangeAcceptanceProbes: "real in-process execution against materialized fixtures",
      baselineRegression: "real vitest runs on clean and defect arms",
    },
    checks,
    smokeRecords,
    summary: {
      total: checks.length,
      passed: checks.filter(({ status }) => status === "passed").length,
      notApplicable: checks.filter(({ status }) => status === "not_applicable").length,
      failed: failed.length,
    },
  };
  const reportPath = outputPath === null
    ? join(dryRunRoot, "report.json")
    : resolve(outputPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `\ndry-run report (${report.classification}): ${reportPath}\n` +
      `${report.summary.passed} passed, ${report.summary.notApplicable} not applicable, ${report.summary.failed} failed\n`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

await main();
