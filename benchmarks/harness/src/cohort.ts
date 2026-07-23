import { canonicalJson, sha256 } from "./hash.js";
import { validateScheduleDocument } from "./schedule.js";
import type {
  BenchmarkArm,
  ConfirmatoryRunBinding,
  FrozenCohortManifest,
  FrozenCohortManifestInput,
  InstructionHashes,
  RunEnvironmentInput,
  RunIdentity,
  ScheduledRun,
} from "./types.js";

const HASH = /^[a-f0-9]{64}$/u;

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

export const cohortTaskKey = (identity: RunIdentity): string =>
  `${identity.task.id}@${identity.task.version}`;

export const createFrozenCohortManifest = (
  input: FrozenCohortManifestInput,
): FrozenCohortManifest => {
  const cloned = structuredClone(input);
  const manifest: FrozenCohortManifest = {
    ...cloned,
    manifestHash: sha256(canonicalJson(cloned)),
  };
  validateFrozenCohortManifest(manifest);
  return deepFreeze(manifest);
};

export const validateFrozenCohortManifest = (
  manifest: FrozenCohortManifest,
): void => {
  const { manifestHash, ...input } = manifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.cohortId.trim().length === 0 ||
    manifest.scheduleSeed.trim().length === 0 ||
    !HASH.test(manifest.scheduleHash) ||
    manifest.provider.trim().length === 0 ||
    manifest.exactModel.trim().length === 0 ||
    manifest.serviceTier.trim().length === 0 ||
    !HASH.test(manifest.reasoningConfigurationHash) ||
    manifest.analysisRevision.trim().length === 0 ||
    !Number.isFinite(manifest.lifecycleTimeoutMs) ||
    manifest.lifecycleTimeoutMs <= 0 ||
    !Number.isFinite(manifest.shutdownTimeoutMs) ||
    manifest.shutdownTimeoutMs <= 0 ||
    !HASH.test(manifest.provisioningConfigurationHash) ||
    manifest.networkPolicy.trim().length === 0 ||
    manifest.dependencyCachePolicy.trim().length === 0 ||
    (manifest.hostClass !== null && manifest.hostClass.trim().length === 0) ||
    (manifest.containerImage !== null && manifest.containerImage.trim().length === 0) ||
    (manifest.packageManager !== null && manifest.packageManager.trim().length === 0) ||
    !HASH.test(manifest.toolVersionsHash) ||
    !HASH.test(manifestHash) ||
    manifestHash !== sha256(canonicalJson(input))
  ) {
    throw new TypeError("Malformed or stale frozen cohort manifest.");
  }
  if (
    (manifest.pricingSnapshotId === null) !==
      (manifest.pricingCurrency === null) ||
    (manifest.pricingSnapshotId !== null &&
      manifest.pricingSnapshotId.trim().length === 0) ||
    (manifest.pricingCurrency !== null &&
      manifest.pricingCurrency.trim().length === 0)
  ) {
    throw new TypeError("Cohort pricing pins must both be null or both be nonempty.");
  }
  const maps = [
    manifest.instructionBundleByTask,
    manifest.fixtureRevisionByTask,
    manifest.fixtureManifestHashByTask,
    manifest.evaluatorRevisionByTask,
    manifest.timeoutMsByTask,
  ];
  if (maps.some((map) => Object.keys(map).length !== 10)) {
    throw new TypeError("Cohort manifest must pin exactly ten task versions.");
  }
  const taskKeys = canonicalJson(
    Object.keys(manifest.instructionBundleByTask).sort(),
  );
  if (
    maps.some(
      (map) => canonicalJson(Object.keys(map).sort()) !== taskKeys,
    )
  ) {
    throw new TypeError("Cohort task-keyed pin maps must use the same task keys.");
  }
  for (const [task, hash] of Object.entries(manifest.instructionBundleByTask)) {
    if (task.trim().length === 0 || !HASH.test(hash)) {
      throw new TypeError("Cohort instruction pins must be task keys and SHA-256 hashes.");
    }
  }
  for (const map of [
    manifest.fixtureRevisionByTask,
    manifest.evaluatorRevisionByTask,
  ]) {
    for (const pins of Object.values(map)) {
      if (pins.framework.trim().length === 0 || pins.plain.trim().length === 0) {
        throw new TypeError("Cohort arm revision pins must not be blank.");
      }
    }
  }
  for (const pins of Object.values(manifest.fixtureManifestHashByTask)) {
    if (!HASH.test(pins.framework) || !HASH.test(pins.plain)) {
      throw new TypeError("Cohort fixture manifests must be SHA-256 hashes.");
    }
  }
  for (const [task, timeoutMs] of Object.entries(manifest.timeoutMsByTask)) {
    if (
      task.trim().length === 0 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new TypeError(
        "Cohort task timeouts must be task keys and positive integer milliseconds.",
      );
    }
  }
};

const selectedArm = <T>(pins: { readonly framework: T; readonly plain: T }, arm: BenchmarkArm): T =>
  pins[arm];

export interface ConfirmatoryBindingEvidence {
  readonly scheduled: ScheduledRun;
  readonly scheduleContentHash: string;
}

export const validateConfirmatoryBinding = (input: {
  readonly binding: ConfirmatoryRunBinding;
  readonly identity: RunIdentity;
  readonly instructionHashes: InstructionHashes;
  readonly adapter: {
    readonly provider: string;
    readonly model: string;
    readonly serviceTier: string;
    readonly reasoning: Readonly<Record<string, unknown>>;
  };
  readonly environment: RunEnvironmentInput;
  readonly timeoutMs: number;
  readonly lifecycleTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly provisioningConfigurationHash: string;
  readonly pricingSnapshotId: string | null;
  readonly pricingCurrency: string | null;
  readonly fixtureManifestHash: string;
}): ConfirmatoryBindingEvidence => {
  const validated = validateScheduleDocument(input.binding.schedule);
  validateFrozenCohortManifest(input.binding.cohort);
  const scheduled = validated.slotsByOrdinal.get(input.binding.ordinal);
  if (scheduled === undefined) throw new TypeError("Confirmatory ordinal is not scheduled.");
  const task = cohortTaskKey(input.identity);
  const cohort = input.binding.cohort;
  const scheduledTasks = [...new Set(input.binding.schedule.runs.map(
    (run) => `${run.task.id}@${run.task.version}`,
  ))].sort();
  for (const [name, pins] of Object.entries({
    instructionBundleByTask: cohort.instructionBundleByTask,
    fixtureRevisionByTask: cohort.fixtureRevisionByTask,
    fixtureManifestHashByTask: cohort.fixtureManifestHashByTask,
    evaluatorRevisionByTask: cohort.evaluatorRevisionByTask,
    timeoutMsByTask: cohort.timeoutMsByTask,
  })) {
    if (canonicalJson(Object.keys(pins).sort()) !== canonicalJson(scheduledTasks)) {
      throw new TypeError(`Cohort ${name} keys do not match the scheduled task set.`);
    }
  }
  const fixtureRevisions = cohort.fixtureRevisionByTask[task];
  const fixtureManifests = cohort.fixtureManifestHashByTask[task];
  const evaluatorRevisions = cohort.evaluatorRevisionByTask[task];
  if (
    cohort.instructionBundleByTask[task] === undefined ||
    fixtureRevisions === undefined ||
    fixtureManifests === undefined ||
    evaluatorRevisions === undefined
  ) {
    throw new TypeError(`Cohort manifest does not pin scheduled task ${task}.`);
  }
  const mismatches: string[] = [];
  const same = (name: string, observed: unknown, expected: unknown): void => {
    if (canonicalJson(observed) !== canonicalJson(expected)) mismatches.push(name);
  };
  same("schedule hash", input.binding.schedule.scheduleHash, cohort.scheduleHash);
  same("schedule seed", input.binding.schedule.seed, cohort.scheduleSeed);
  same("identity schedule seed", input.identity.scheduleSeed, cohort.scheduleSeed);
  same("scheduled task", scheduled.task, input.identity.task);
  same("scheduled arm", scheduled.arm, input.identity.arm);
  same("scheduled repetition", scheduled.repetition, input.identity.repetition);
  same("instruction bundle", input.instructionHashes.bundle, cohort.instructionBundleByTask[task]);
  same("fixture revision", input.identity.fixtureRevision,
    selectedArm(fixtureRevisions, input.identity.arm));
  same("fixture manifest", input.fixtureManifestHash,
    selectedArm(fixtureManifests, input.identity.arm));
  same("evaluator revision", input.identity.evaluatorRevision,
    selectedArm(evaluatorRevisions, input.identity.arm));
  same("analysis revision", input.identity.analysisRevision, cohort.analysisRevision);
  same("provider", input.adapter.provider, cohort.provider);
  same("exact model", input.adapter.model, cohort.exactModel);
  same("service tier", input.adapter.serviceTier, cohort.serviceTier);
  same("reasoning configuration", sha256(canonicalJson(input.adapter.reasoning)),
    cohort.reasoningConfigurationHash);
  same("task timeout", input.timeoutMs, cohort.timeoutMsByTask[task]);
  same("lifecycle timeout", input.lifecycleTimeoutMs, cohort.lifecycleTimeoutMs);
  same("shutdown timeout", input.shutdownTimeoutMs, cohort.shutdownTimeoutMs);
  same("provisioning configuration", input.provisioningConfigurationHash,
    cohort.provisioningConfigurationHash);
  same("network policy", input.environment.networkPolicy, cohort.networkPolicy);
  same("dependency cache policy", input.environment.dependencyCachePolicy,
    cohort.dependencyCachePolicy);
  same("host class", input.environment.hostClass, cohort.hostClass);
  same("container image", input.environment.containerImage, cohort.containerImage);
  same("package manager", input.environment.packageManager, cohort.packageManager);
  same("tool versions", sha256(canonicalJson(input.environment.toolVersions)),
    cohort.toolVersionsHash);
  same("pricing snapshot", input.pricingSnapshotId, cohort.pricingSnapshotId);
  same("pricing currency", input.pricingCurrency, cohort.pricingCurrency);
  if (mismatches.length > 0) {
    throw new TypeError(`Confirmatory cohort mismatch: ${mismatches.join(", ")}.`);
  }
  return { scheduled, scheduleContentHash: validated.contentHash };
};
