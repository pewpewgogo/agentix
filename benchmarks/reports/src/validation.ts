import {
  canonicalJson,
  HARNESS_SCHEMA_VERSION,
  sha256,
  type PricingSnapshot,
  type ScheduleDocument,
  type ScheduledRun,
  type TaskReference,
} from "@agentixdev/benchmark-harness";

import type {
  AnalysisConfiguration,
  ArmPins,
  ConstructionMetricInput,
  ConstructionMoneyInput,
} from "./types.js";

export const ANALYSIS_VERSION = "analysis-v1" as const;
export const FROZEN_THRESHOLDS = Object.freeze({
  correctnessMargin: 0.05,
  minimumTokenReduction: 0.2,
  minimumImprovedCategories: 7,
} as const);

const SHA256 = /^[a-f0-9]{64}$/u;
const TASK_ID = /^[a-z0-9][a-z0-9._-]*$/u;

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unexpected or missing fields.`);
  }
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value;
};

const nullableString = (value: unknown, label: string): string | null =>
  value === null ? null : string(value, label);

const hash = (value: unknown, label: string): string => {
  const result = string(value, label);
  if (!SHA256.test(result)) throw new TypeError(`${label} must be a SHA-256 hex digest.`);
  return result;
};

const nullableHash = (value: unknown, label: string): string | null =>
  value === null ? null : hash(value, label);

const boolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
};

const booleanOrNull = (value: unknown, label: string): boolean | null =>
  value === null ? null : boolean(value, label);

const positiveInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value as number;
};

const nonnegativeNumberOrNull = (value: unknown, label: string): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be null or a nonnegative finite number.`);
  }
  return value;
};

const hashMap = (value: unknown, label: string): Readonly<Record<string, string>> => {
  const entries = object(value, label);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(entries).map(([key, entry]) => [
        string(key, `${label} key`),
        hash(entry, `${label}.${key}`),
      ]),
    ),
  );
};

const positiveIntegerMap = (
  value: unknown,
  label: string,
): Readonly<Record<string, number>> => {
  const entries = object(value, label);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(entries).map(([key, entry]) => [
        string(key, `${label} key`),
        positiveInteger(entry, `${label}.${key}`),
      ]),
    ),
  );
};

const armPinMap = (
  value: unknown,
  label: string,
): Readonly<Record<string, ArmPins<string>>> => {
  const entries = object(value, label);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(entries).map(([key, entry]) => {
        const pins = object(entry, `${label}.${key}`);
        exactKeys(pins, ["framework", "plain"], `${label}.${key}`);
        return [
          string(key, `${label} key`),
          Object.freeze({
            framework: string(pins["framework"], `${label}.${key}.framework`),
            plain: string(pins["plain"], `${label}.${key}.plain`),
          }),
        ];
      }),
    ),
  );
};

const armHashPinMap = (
  value: unknown,
  label: string,
): Readonly<Record<string, ArmPins<string>>> => {
  const entries = object(value, label);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(entries).map(([key, entry]) => {
        const pins = object(entry, `${label}.${key}`);
        exactKeys(pins, ["framework", "plain"], `${label}.${key}`);
        return [
          string(key, `${label} key`),
          Object.freeze({
            framework: hash(pins["framework"], `${label}.${key}.framework`),
            plain: hash(pins["plain"], `${label}.${key}.plain`),
          }),
        ];
      }),
    ),
  );
};

const constructionMetric = (
  value: unknown,
  label: string,
): ConstructionMetricInput => {
  const input = object(value, label);
  exactKeys(input, ["value", "unavailableReason"], label);
  const rawValue = input["value"];
  if (rawValue !== null && (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0)) {
    throw new TypeError(`${label}.value must be null or nonnegative and finite.`);
  }
  const unavailableReason = nullableString(
    input["unavailableReason"],
    `${label}.unavailableReason`,
  );
  if ((rawValue === null) !== (unavailableReason !== null)) {
    throw new TypeError(`${label} requires exactly one of value or unavailableReason.`);
  }
  return Object.freeze({ value: rawValue as number | null, unavailableReason });
};

const constructionMoney = (
  value: unknown,
  label: string,
): ConstructionMoneyInput => {
  const input = object(value, label);
  exactKeys(input, ["value", "unavailableReason", "currency"], label);
  const base = constructionMetric(
    { value: input["value"], unavailableReason: input["unavailableReason"] },
    label,
  );
  const currency = nullableString(input["currency"], `${label}.currency`);
  if (base.value !== null && currency === null) {
    throw new TypeError(`${label}.currency is required with a monetary value.`);
  }
  return Object.freeze({ ...base, currency });
};

export const parsePricingSnapshot = (value: unknown): PricingSnapshot => {
  const root = object(value, "pricing snapshot");
  exactKeys(
    root,
    [
      "schemaVersion",
      "id",
      "provider",
      "model",
      "serviceTier",
      "currency",
      "effectiveAt",
      "unitTokens",
      "perUnit",
    ],
    "pricing snapshot",
  );
  if (root["schemaVersion"] !== 1) {
    throw new TypeError("Unsupported pricing snapshot schema.");
  }
  const effectiveAt = string(root["effectiveAt"], "pricingSnapshot.effectiveAt");
  if (!Number.isFinite(Date.parse(effectiveAt))) {
    throw new TypeError("pricingSnapshot.effectiveAt must be a valid timestamp.");
  }
  const perUnit = object(root["perUnit"], "pricingSnapshot.perUnit");
  exactKeys(
    perUnit,
    ["uncachedInput", "cachedInput", "output", "reasoning"],
    "pricingSnapshot.perUnit",
  );
  return Object.freeze({
    schemaVersion: 1,
    id: string(root["id"], "pricingSnapshot.id"),
    provider: string(root["provider"], "pricingSnapshot.provider"),
    model: string(root["model"], "pricingSnapshot.model"),
    serviceTier: string(root["serviceTier"], "pricingSnapshot.serviceTier"),
    currency: string(root["currency"], "pricingSnapshot.currency"),
    effectiveAt,
    unitTokens: positiveInteger(root["unitTokens"], "pricingSnapshot.unitTokens"),
    perUnit: Object.freeze({
      uncachedInput: nonnegativeNumberOrNull(
        perUnit["uncachedInput"],
        "pricingSnapshot.perUnit.uncachedInput",
      ),
      cachedInput: nonnegativeNumberOrNull(
        perUnit["cachedInput"],
        "pricingSnapshot.perUnit.cachedInput",
      ),
      output: nonnegativeNumberOrNull(
        perUnit["output"],
        "pricingSnapshot.perUnit.output",
      ),
      reasoning: nonnegativeNumberOrNull(
        perUnit["reasoning"],
        "pricingSnapshot.perUnit.reasoning",
      ),
    }),
  });
};

export const parseAnalysisConfiguration = (value: unknown): AnalysisConfiguration => {
  const root = object(value, "analysis configuration");
  exactKeys(
    root,
    [
      "schemaVersion",
      "analysisVersion",
      "studyPhase",
      "thresholds",
      "cohort",
      "manifestHashes",
      "gates",
      "constructionCost",
      "runIds",
    ],
    "analysis configuration",
  );
  if (root["schemaVersion"] !== 1) throw new TypeError("Unsupported configuration schema.");
  if (root["analysisVersion"] !== ANALYSIS_VERSION) {
    throw new TypeError(`Analysis version must be exactly ${ANALYSIS_VERSION}.`);
  }
  if (root["studyPhase"] !== "confirmatory" && root["studyPhase"] !== "pilot") {
    throw new TypeError("studyPhase must be confirmatory or pilot.");
  }

  const thresholds = object(root["thresholds"], "thresholds");
  exactKeys(
    thresholds,
    ["correctnessMargin", "minimumTokenReduction", "minimumImprovedCategories"],
    "thresholds",
  );
  if (
    thresholds["correctnessMargin"] !== FROZEN_THRESHOLDS.correctnessMargin ||
    thresholds["minimumTokenReduction"] !== FROZEN_THRESHOLDS.minimumTokenReduction ||
    thresholds["minimumImprovedCategories"] !==
      FROZEN_THRESHOLDS.minimumImprovedCategories
  ) {
    throw new TypeError("Preregistered thresholds must remain exactly 0.05, 0.20, and 7.");
  }

  const cohort = object(root["cohort"], "cohort");
  exactKeys(
    cohort,
    [
      "schemaVersion",
      "cohortId",
      "provider",
      "exactModel",
      "serviceTier",
      "reasoningConfigurationHash",
      "instructionBundleByTask",
      "fixtureRevisionByTask",
      "fixtureManifestHashByTask",
      "evaluatorRevisionByTask",
      "analysisRevision",
      "scheduleSeed",
      "scheduleHash",
      "timeoutMsByTask",
      "lifecycleTimeoutMs",
      "shutdownTimeoutMs",
      "provisioningConfigurationHash",
      "networkPolicy",
      "dependencyCachePolicy",
      "hostClass",
      "containerImage",
      "packageManager",
      "toolVersionsHash",
      "pricingSnapshotId",
      "pricingCurrency",
      "manifestHash",
    ],
    "cohort",
  );

  const manifests = object(root["manifestHashes"], "manifestHashes");
  exactKeys(
    manifests,
    [
      "schedule",
      "taskCorpus",
      "evaluator",
      "analysisSource",
      "equivalenceEvidence",
      "runtimeDxEvidence",
      "constructionCostEvidence",
      "pricingSnapshot",
    ],
    "manifestHashes",
  );
  const gates = object(root["gates"], "gates");
  exactKeys(
    gates,
    [
      "equivalencePassed",
      "freshSessionReproductionEstablished",
      "runtimeAndDxBudgetsPassed",
      "criticalRegressionReviewPassed",
      "protocolCompromised",
    ],
    "gates",
  );
  const construction = object(root["constructionCost"], "constructionCost");
  exactKeys(construction, ["tokens", "money"], "constructionCost");
  if (!Array.isArray(root["runIds"])) throw new TypeError("runIds must be an array.");
  const runIds = Object.freeze(
    root["runIds"].map((entry, index) => string(entry, `runIds[${index}]`)),
  );
  if (new Set(runIds).size !== runIds.length) {
    throw new TypeError("Configuration contains duplicate run IDs.");
  }

  const constructionTokens = constructionMetric(
    construction["tokens"],
    "constructionCost.tokens",
  );
  const constructionMoneyValue = constructionMoney(
    construction["money"],
    "constructionCost.money",
  );
  const constructionEvidence = nullableHash(
    manifests["constructionCostEvidence"],
    "manifestHashes.constructionCostEvidence",
  );
  const pricingSnapshot = nullableHash(
    manifests["pricingSnapshot"],
    "manifestHashes.pricingSnapshot",
  );
  const pricingSnapshotId = nullableString(
    cohort["pricingSnapshotId"],
    "cohort.pricingSnapshotId",
  );
  const pricingCurrency = nullableString(
    cohort["pricingCurrency"],
    "cohort.pricingCurrency",
  );
  if (
    (constructionTokens.value !== null || constructionMoneyValue.value !== null) &&
    constructionEvidence === null
  ) {
    throw new TypeError("Available construction cost requires a pinned evidence hash.");
  }
  if ((pricingSnapshotId === null) !== (pricingCurrency === null)) {
    throw new TypeError("Pricing snapshot ID and currency must be pinned together.");
  }
  if ((pricingSnapshotId === null) !== (pricingSnapshot === null)) {
    throw new TypeError("Pricing cohort pins and pricing manifest hash must be present together.");
  }

  if (cohort["schemaVersion"] !== 1) {
    throw new TypeError("Unsupported frozen cohort schema.");
  }
  const parsedCohort = Object.freeze({
    schemaVersion: 1 as const,
    cohortId: string(cohort["cohortId"], "cohort.cohortId"),
    scheduleSeed: string(cohort["scheduleSeed"], "cohort.scheduleSeed"),
    scheduleHash: hash(cohort["scheduleHash"], "cohort.scheduleHash"),
    provider: string(cohort["provider"], "cohort.provider"),
    exactModel: string(cohort["exactModel"], "cohort.exactModel"),
    serviceTier: string(cohort["serviceTier"], "cohort.serviceTier"),
    reasoningConfigurationHash: hash(
      cohort["reasoningConfigurationHash"],
      "cohort.reasoningConfigurationHash",
    ),
    instructionBundleByTask: hashMap(
      cohort["instructionBundleByTask"],
      "cohort.instructionBundleByTask",
    ),
    fixtureRevisionByTask: armPinMap(
      cohort["fixtureRevisionByTask"],
      "cohort.fixtureRevisionByTask",
    ),
    fixtureManifestHashByTask: armHashPinMap(
      cohort["fixtureManifestHashByTask"],
      "cohort.fixtureManifestHashByTask",
    ),
    evaluatorRevisionByTask: armPinMap(
      cohort["evaluatorRevisionByTask"],
      "cohort.evaluatorRevisionByTask",
    ),
    analysisRevision: string(cohort["analysisRevision"], "cohort.analysisRevision"),
    timeoutMsByTask: positiveIntegerMap(
      cohort["timeoutMsByTask"],
      "cohort.timeoutMsByTask",
    ),
    lifecycleTimeoutMs: positiveInteger(
      cohort["lifecycleTimeoutMs"],
      "cohort.lifecycleTimeoutMs",
    ),
    shutdownTimeoutMs: positiveInteger(
      cohort["shutdownTimeoutMs"],
      "cohort.shutdownTimeoutMs",
    ),
    provisioningConfigurationHash: hash(
      cohort["provisioningConfigurationHash"],
      "cohort.provisioningConfigurationHash",
    ),
    networkPolicy: string(cohort["networkPolicy"], "cohort.networkPolicy"),
    dependencyCachePolicy: string(
      cohort["dependencyCachePolicy"],
      "cohort.dependencyCachePolicy",
    ),
    hostClass: nullableString(cohort["hostClass"], "cohort.hostClass"),
    containerImage: nullableString(cohort["containerImage"], "cohort.containerImage"),
    packageManager: nullableString(cohort["packageManager"], "cohort.packageManager"),
    toolVersionsHash: hash(cohort["toolVersionsHash"], "cohort.toolVersionsHash"),
    pricingSnapshotId,
    pricingCurrency,
    manifestHash: hash(cohort["manifestHash"], "cohort.manifestHash"),
  });
  const { manifestHash, ...cohortManifestInput } = parsedCohort;
  if (manifestHash !== sha256(canonicalJson(cohortManifestInput))) {
    throw new TypeError("Frozen cohort manifest hash is stale or malformed.");
  }

  return Object.freeze({
    schemaVersion: 1,
    analysisVersion: ANALYSIS_VERSION,
    studyPhase: root["studyPhase"],
    thresholds: FROZEN_THRESHOLDS,
    cohort: parsedCohort,
    manifestHashes: Object.freeze({
      schedule: hash(manifests["schedule"], "manifestHashes.schedule"),
      taskCorpus: hash(manifests["taskCorpus"], "manifestHashes.taskCorpus"),
      evaluator: hash(manifests["evaluator"], "manifestHashes.evaluator"),
      analysisSource: hash(
        manifests["analysisSource"],
        "manifestHashes.analysisSource",
      ),
      equivalenceEvidence: hash(
        manifests["equivalenceEvidence"],
        "manifestHashes.equivalenceEvidence",
      ),
      runtimeDxEvidence: hash(
        manifests["runtimeDxEvidence"],
        "manifestHashes.runtimeDxEvidence",
      ),
      constructionCostEvidence: constructionEvidence,
      pricingSnapshot,
    }),
    gates: Object.freeze({
      equivalencePassed: boolean(gates["equivalencePassed"], "gates.equivalencePassed"),
      freshSessionReproductionEstablished: boolean(
        gates["freshSessionReproductionEstablished"],
        "gates.freshSessionReproductionEstablished",
      ),
      runtimeAndDxBudgetsPassed: booleanOrNull(
        gates["runtimeAndDxBudgetsPassed"],
        "gates.runtimeAndDxBudgetsPassed",
      ),
      criticalRegressionReviewPassed: booleanOrNull(
        gates["criticalRegressionReviewPassed"],
        "gates.criticalRegressionReviewPassed",
      ),
      protocolCompromised: boolean(
        gates["protocolCompromised"],
        "gates.protocolCompromised",
      ),
    }),
    constructionCost: Object.freeze({
      tokens: constructionTokens,
      money: constructionMoneyValue,
    }),
    runIds,
  });
};

const parseTask = (value: unknown, label: string): TaskReference => {
  const task = object(value, label);
  exactKeys(task, ["schemaVersion", "id", "version"], label);
  if (task["schemaVersion"] !== HARNESS_SCHEMA_VERSION) {
    throw new TypeError(`${label} has an unsupported schema version.`);
  }
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: string(task["id"], `${label}.id`),
    version: positiveInteger(task["version"], `${label}.version`),
  };
};

export const parseScheduleDocument = (value: unknown): ScheduleDocument => {
  const root = object(value, "schedule");
  exactKeys(
    root,
    ["schemaVersion", "seed", "repetitions", "taskCount", "scheduleHash", "runs"],
    "schedule",
  );
  if (root["schemaVersion"] !== 1 || !Array.isArray(root["runs"])) {
    throw new TypeError("Malformed schedule document.");
  }
  const runs: ScheduledRun[] = root["runs"].map((value, index) => {
    const run = object(value, `schedule.runs[${index}]`);
    exactKeys(
      run,
      ["ordinal", "blockId", "task", "arm", "repetition"],
      `schedule.runs[${index}]`,
    );
    if (run["arm"] !== "framework" && run["arm"] !== "plain") {
      throw new TypeError(`schedule.runs[${index}].arm is invalid.`);
    }
    return {
      ordinal: positiveInteger(run["ordinal"], `schedule.runs[${index}].ordinal`),
      blockId: string(run["blockId"], `schedule.runs[${index}].blockId`),
      task: parseTask(run["task"], `schedule.runs[${index}].task`),
      arm: run["arm"],
      repetition: positiveInteger(
        run["repetition"],
        `schedule.runs[${index}].repetition`,
      ),
    };
  });
  return {
    schemaVersion: 1,
    seed: string(root["seed"], "schedule.seed"),
    repetitions: positiveInteger(root["repetitions"], "schedule.repetitions"),
    taskCount: positiveInteger(root["taskCount"], "schedule.taskCount"),
    scheduleHash: hash(root["scheduleHash"], "schedule.scheduleHash"),
    runs,
  };
};

export const taskKey = (task: TaskReference): string => `${task.id}@${task.version}`;

export const slotKey = (run: {
  readonly task: TaskReference;
  readonly arm: "framework" | "plain";
  readonly repetition: number;
}): string => `${taskKey(run.task)}|${run.arm}|${run.repetition}`;

export interface ValidatedSchedule {
  readonly schedule: ScheduleDocument;
  readonly taskKeys: readonly string[];
  readonly slots: ReadonlyMap<string, ScheduledRun>;
  readonly contentHash: string;
}

export const validateSchedule = (
  schedule: ScheduleDocument,
): ValidatedSchedule => {
  if (schedule.taskCount !== 10 || schedule.repetitions < 5) {
    throw new TypeError("Confirmatory schedule requires exactly 10 tasks and at least 5 repetitions.");
  }
  const hashInput = {
    schemaVersion: schedule.schemaVersion,
    seed: schedule.seed,
    repetitions: schedule.repetitions,
    taskCount: schedule.taskCount,
    runs: schedule.runs,
  };
  if (schedule.scheduleHash !== sha256(canonicalJson(hashInput))) {
    throw new TypeError("Schedule hash mismatch.");
  }
  if (schedule.runs.length !== schedule.taskCount * schedule.repetitions * 2) {
    throw new TypeError("Schedule does not contain the exact expected number of slots.");
  }
  const ordinals = schedule.runs.map(({ ordinal }) => ordinal).sort((a, b) => a - b);
  if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
    throw new TypeError("Schedule ordinals are not exact and contiguous.");
  }
  const tasks = new Map<string, TaskReference>();
  const versionById = new Map<string, number>();
  const slots = new Map<string, ScheduledRun>();
  const blocks = new Map<string, ScheduledRun[]>();
  for (const run of schedule.runs) {
    if (!TASK_ID.test(run.task.id)) {
      throw new TypeError(`Schedule task ID is not canonical: ${run.task.id}.`);
    }
    const key = taskKey(run.task);
    tasks.set(key, run.task);
    const existingVersion = versionById.get(run.task.id);
    if (existingVersion !== undefined && existingVersion !== run.task.version) {
      throw new TypeError(`Schedule pools task versions for ${run.task.id}.`);
    }
    versionById.set(run.task.id, run.task.version);
    if (run.repetition > schedule.repetitions) {
      throw new TypeError(`Schedule repetition exceeds the declared count for ${key}.`);
    }
    const slot = slotKey(run);
    if (slots.has(slot)) throw new TypeError(`Duplicate scheduled slot ${slot}.`);
    slots.set(slot, run);
    const block = blocks.get(run.blockId) ?? [];
    block.push(run);
    blocks.set(run.blockId, block);
  }
  if (tasks.size !== 10) throw new TypeError("Schedule does not contain ten unique task versions.");
  for (const [blockId, block] of blocks) {
    if (
      block.length !== 2 ||
      block[0]?.task.id !== block[1]?.task.id ||
      block[0]?.task.version !== block[1]?.task.version ||
      block[0]?.repetition !== block[1]?.repetition ||
      new Set(block.map(({ arm }) => arm)).size !== 2
    ) {
      throw new TypeError(`Malformed blocked pair ${blockId}.`);
    }
  }
  for (const task of tasks.values()) {
    for (let repetition = 1; repetition <= schedule.repetitions; repetition += 1) {
      for (const arm of ["framework", "plain"] as const) {
        if (!slots.has(slotKey({ task, arm, repetition }))) {
          throw new TypeError(`Missing scheduled slot ${taskKey(task)}|${arm}|${repetition}.`);
        }
      }
    }
  }
  return Object.freeze({
    schedule,
    taskKeys: Object.freeze([...tasks.keys()].sort()),
    slots,
    contentHash: sha256(canonicalJson(schedule)),
  });
};
