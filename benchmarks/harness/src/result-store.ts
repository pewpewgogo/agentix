import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { deriveEvaluationSummary, validateLifecycleChecks } from "./evaluation.js";
import { validateFrozenCohortManifest } from "./cohort.js";
import { canonicalJson, sha256 } from "./hash.js";
import { validateScheduleDocument } from "./schedule.js";
import {
  deriveAccountedTokens,
  validateInteractionSummary,
  validateProviderUsage,
} from "./telemetry.js";
import {
  HARNESS_SCHEMA_VERSION,
  type AgentArtifactInput,
  type ArtifactRecord,
  type InteractionSummary,
  type LifecycleCheck,
  type RawProviderUsage,
  type RunCorrectionProvenance,
  type RunRecord,
  type ScheduleDocument,
  type FrozenCohortManifest,
} from "./types.js";
import {
  normalizeWorkspacePath,
  SNAPSHOT_EXCLUDED_DIRECTORY_NAMES,
} from "./workspace.js";

const RESULT_FORMAT = "agentix-benchmark-run";
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const HASH = /^[a-f0-9]{64}$/u;

export type RunRecordDraft = Omit<RunRecord, "artifacts" | "correction"> & {
  /** Corrections must be created by writeImmutableRunCorrection. */
  readonly correction?: never;
};

type StoredRunRecordDraft = Omit<RunRecord, "artifacts">;

export class DuplicateRunIdError extends Error {
  public constructor(runId: string) {
    super(`Immutable result for run ID ${runId} already exists.`);
    this.name = "DuplicateRunIdError";
  }
}

export class ResultIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResultIntegrityError";
  }
}

function fail(message: string): never {
  throw new ResultIntegrityError(message);
}

const assertRunId = (runId: string): void => {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    fail(`Unsafe run ID: ${runId}`);
  }
};

const within = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
};

const parseJson = (name: string, value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fail(`${name} is truncated or is not valid JSON.`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${name} must be an object.`);
  return value;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${name} must be a nonempty string.`);
  }
  return value;
}

function finite(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    fail(`${name} must be a finite number >= ${minimum}.`);
  }
  return value;
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${name} must be a SHA-256 hash.`);
  return value;
}

const oneOf = <T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T => {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(`${name} has an unsupported value.`);
  }
  return value as T;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

const validateChecks = (value: unknown, name: string): readonly LifecycleCheck[] => {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
  const values = value as unknown[];
  for (const raw of values) {
    const check = object(raw, `${name} check`);
    nonempty(check["name"], `${name} check name`);
    oneOf(check["status"], ["passed", "failed", "not_applicable"], `${name} check status`);
    safeInteger(check["durationMs"], `${name} check duration`);
    if (check["details"] !== null && typeof check["details"] !== "string") {
      fail(`${name} check details must be a string or null.`);
    }
  }
  try {
    validateLifecycleChecks(values as readonly LifecycleCheck[], name);
  } catch (error: unknown) {
    fail(`Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return values as unknown as readonly LifecycleCheck[];
};

export function validateRunRecord(
  value: unknown,
  expectedRunId: string,
): asserts value is RunRecord {
  const record = object(value, "Run record");
  if (record["schemaVersion"] !== HARNESS_SCHEMA_VERSION) fail("Unsupported run-record schema version.");
  const mode = oneOf(record["mode"], ["smoke", "confirmatory"], "Run mode");
  const identity = object(record["identity"], "Run identity");
  if (identity["schemaVersion"] !== HARNESS_SCHEMA_VERSION) fail("Unsupported run-identity schema version.");
  if (identity["runId"] !== expectedRunId) fail("Run ID does not match its immutable directory.");
  assertRunId(expectedRunId);
  const task = object(identity["task"], "Task reference");
  if (task["schemaVersion"] !== HARNESS_SCHEMA_VERSION) fail("Unsupported task-reference schema version.");
  nonempty(task["id"], "Task ID");
  if (!Number.isSafeInteger(task["version"]) || (task["version"] as number) < 1) fail("Malformed task version.");
  const arm = oneOf(identity["arm"], ["framework", "plain"], "Benchmark arm");
  if (!Number.isSafeInteger(identity["repetition"]) || (identity["repetition"] as number) < 1) fail("Malformed repetition.");
  for (const key of ["scheduleSeed", "fixtureRevision", "evaluatorRevision", "analysisRevision"] as const) {
    nonempty(identity[key], `Identity ${key}`);
  }
  nonempty(record["adapterId"], "Adapter ID");
  const instructionHashes = object(record["instructionHashes"], "Instruction hashes");
  if (instructionHashes["algorithm"] !== "sha256" || instructionHashes["normalization"] !== "unicode-nfc+lf") {
    fail("Unsupported instruction hashing declaration.");
  }
  for (const key of ["system", "developer", "user", "tools", "permissions", "limits", "bundle"] as const) {
    hash(instructionHashes[key], `Instruction hash ${key}`);
  }
  const environment = object(record["environment"], "Environment");
  for (const key of ["node", "platform", "architecture", "osRelease", "cpuModel", "dependencyCachePolicy", "networkPolicy"] as const) {
    nonempty(environment[key], `Environment ${key}`);
  }
  if (!Number.isSafeInteger(environment["cpuCount"]) || (environment["cpuCount"] as number) < 1) fail("Environment CPU count is invalid.");
  for (const key of ["containerImage", "hostClass", "packageManager"] as const) {
    if (environment[key] !== null && (typeof environment[key] !== "string" || (environment[key] as string).trim().length === 0)) {
      fail(`Environment ${key} must be null or nonempty.`);
    }
  }
  const toolVersions = object(environment["toolVersions"], "Tool versions");
  for (const [tool, version] of Object.entries(toolVersions)) {
    if (tool.trim().length === 0 || typeof version !== "string" || version.trim().length === 0) fail("Tool-version entries must be nonempty strings.");
  }
  const startedAt = nonempty(record["startedAt"], "Start time");
  const endedAt = nonempty(record["endedAt"], "End time");
  if (Number.isNaN(Date.parse(startedAt)) || Number.isNaN(Date.parse(endedAt)) || Date.parse(endedAt) < Date.parse(startedAt)) fail("Run timestamps are invalid or reversed.");
  finite(record["durationMs"], "Run duration");
  finite(record["timeoutMs"], "Run timeout", Number.MIN_VALUE);
  const completionStatus = oneOf(record["completionStatus"], ["completed", "agent_error", "timeout", "aborted", "preflight_failed", "evaluator_error"], "Completion status");
  nonempty(record["completionReason"], "Completion reason");

  const correctionRaw = record["correction"];
  if (correctionRaw !== undefined) {
    const correction = object(correctionRaw, "Correction provenance");
    if (correction["schemaVersion"] !== 1) {
      fail("Unsupported correction-provenance schema version.");
    }
    const supersededRunId = nonempty(
      correction["supersededRunId"],
      "Superseded run ID",
    );
    assertRunId(supersededRunId);
    if (supersededRunId === expectedRunId) {
      fail("A correction cannot supersede itself.");
    }
    hash(correction["supersededRecordSha256"], "Superseded record hash");
    nonempty(correction["reason"], "Correction reason");
    const recordedAt = nonempty(correction["recordedAt"], "Correction time");
    const parsedRecordedAt = new Date(recordedAt);
    if (
      Number.isNaN(parsedRecordedAt.valueOf()) ||
      parsedRecordedAt.toISOString() !== recordedAt
    ) {
      fail("Correction time must be a canonical UTC ISO timestamp.");
    }
  }

  const agentOutcomeRaw = record["agentOutcome"];
  if (mode === "confirmatory" && !isRecord(agentOutcomeRaw)) fail("Confirmatory record lacks agent outcome.");
  if (isRecord(agentOutcomeRaw)) {
    const status = oneOf(agentOutcomeRaw["status"], ["completed", "agent_error", "timeout", "aborted", "not_run"], "Agent outcome");
    nonempty(agentOutcomeRaw["reason"], "Agent outcome reason");
    if (typeof agentOutcomeRaw["shutdownConfirmed"] !== "boolean") fail("Agent shutdown confirmation must be boolean.");
    const expected = status === "not_run" ? "preflight_failed" : status;
    if (completionStatus !== expected) fail("Completion status disagrees with the agent outcome.");
  }
  const evaluatorOutcome = record["evaluatorOutcome"];
  if (mode === "confirmatory" && !isRecord(evaluatorOutcome)) fail("Confirmatory record lacks evaluator outcome.");
  if (isRecord(evaluatorOutcome)) {
    oneOf(evaluatorOutcome["status"], ["completed", "failed", "timed_out", "aborted", "not_run"], "Evaluator outcome");
    nonempty(evaluatorOutcome["reason"], "Evaluator outcome reason");
  }
  const finalizationOutcome = record["finalizationOutcome"];
  if (mode === "confirmatory" && !isRecord(finalizationOutcome)) fail("Confirmatory record lacks finalization outcome.");
  if (isRecord(finalizationOutcome)) {
    oneOf(finalizationOutcome["status"], ["completed", "evidence_unavailable"], "Finalization outcome");
    nonempty(finalizationOutcome["reason"], "Finalization reason");
  }

  const evidence = record["confirmatoryEvidence"];
  if (mode === "confirmatory") {
    const confirm = object(evidence, "Confirmatory evidence");
    hash(confirm["scheduleHash"], "Schedule hash");
    hash(confirm["scheduleContentHash"], "Schedule content hash");
    if (!Number.isSafeInteger(confirm["ordinal"]) || (confirm["ordinal"] as number) < 1) fail("Confirmatory ordinal is invalid.");
    nonempty(confirm["blockId"], "Confirmatory block ID");
    hash(confirm["cohortManifestHash"], "Cohort manifest hash");
    hash(confirm["initialFixtureManifestHash"], "Initial fixture manifest hash");
    hash(confirm["provisioningConfigurationHash"], "Provisioning configuration hash");
    finite(confirm["lifecycleTimeoutMs"], "Lifecycle timeout", Number.MIN_VALUE);
    finite(confirm["shutdownTimeoutMs"], "Shutdown timeout", Number.MIN_VALUE);
    hash(confirm["toolVersionsHash"], "Tool versions hash");
    nonempty(confirm["approvalReference"], "Approval reference");
    const sandbox = object(confirm["sandbox"], "Sandbox attestation");
    if (sandbox["isolated"] !== true || sandbox["killable"] !== true || sandbox["kind"] !== "os-level-process-sandbox") fail("Sandbox attestation is not runtime-verifiable and killable.");
    nonempty(sandbox["workspacePath"], "Sandbox workspace");
    nonempty(sandbox["networkPolicy"], "Sandbox network policy");
    nonempty(sandbox["attestationReference"], "Sandbox attestation reference");
  } else if (evidence !== null && evidence !== undefined) {
    fail("Smoke records cannot claim confirmatory evidence.");
  }

  for (const key of ["provider", "model", "serviceTier"] as const) nonempty(record[key], key);
  object(record["reasoningConfiguration"], "Reasoning configuration");
  if (!Array.isArray(record["responseIds"]) || record["responseIds"].some((id) => typeof id !== "string" || id.trim().length === 0)) fail("Response IDs must be nonempty strings.");
  try {
    validateProviderUsage(record["usage"] as RawProviderUsage);
  } catch (error: unknown) {
    fail(`Invalid raw usage: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (mode === "confirmatory" && (record["usage"] as RawProviderUsage).inputTokenRelation === undefined) fail("Confirmatory usage omits input-token overlap semantics.");
  if (canonicalJson(record["accountedTokens"]) !== canonicalJson(deriveAccountedTokens(record["usage"] as RawProviderUsage))) fail("Stored accounted tokens do not match raw counters and accounting semantics.");
  const cost = object(record["cost"], "Derived cost");
  const costAvailability = oneOf(cost["availability"], ["available", "unavailable"], "Cost availability");
  if (costAvailability === "available") {
    finite(cost["amount"], "Cost amount");
    nonempty(cost["currency"], "Cost currency");
    nonempty(cost["pricingSnapshotId"], "Pricing snapshot ID");
    nonempty(cost["formula"], "Cost formula");
  } else {
    if (cost["amount"] !== null || typeof cost["reason"] !== "string" || (cost["reason"] as string).trim().length === 0) {
      fail("Unavailable cost must be null with a reason.");
    }
    for (const key of ["currency", "pricingSnapshotId"] as const) {
      if (
        cost[key] !== null &&
        (typeof cost[key] !== "string" || (cost[key] as string).trim().length === 0)
      ) {
        fail(`Unavailable cost ${key} must be null or nonempty.`);
      }
    }
  }

  const provisioning = record["provisioning"] === undefined
    ? []
    : validateChecks(record["provisioning"], "provisioning");
  if (mode === "confirmatory" && provisioning.length === 0) {
    fail("Confirmatory provisioning evidence must be nonempty.");
  }
  const preflight = validateChecks(record["preflight"], "preflight");
  if (mode === "confirmatory" && preflight.length === 0) {
    fail("Confirmatory preflight evidence must be nonempty.");
  }
  const interaction = object(record["interaction"], "Interaction summary");
  if (!Array.isArray(interaction["events"])) fail("Interaction events must be an array.");
  try {
    validateInteractionSummary(interaction as unknown as InteractionSummary);
  } catch (error: unknown) {
    fail(`Invalid interaction summary: ${error instanceof Error ? error.message : String(error)}`);
  }
  const patch = object(record["patch"], "Patch summary");
  const modifiedFiles = patch["filesModified"];
  if (!Array.isArray(modifiedFiles)) fail("Patch file changes must be an array.");
  let generated = 0;
  let added = 0;
  let deleted = 0;
  const paths = new Set<string>();
  for (const raw of modifiedFiles) {
    const change = object(raw, "File change");
    const path = nonempty(change["path"], "Changed path");
    try { normalizeWorkspacePath(path); } catch { fail(`Invalid changed path: ${path}`); }
    if (paths.has(path)) fail(`Duplicate changed path: ${path}`);
    paths.add(path);
    oneOf(change["kind"], ["added", "modified", "deleted"], "File-change kind");
    added += safeInteger(change["linesAdded"], "Lines added");
    deleted += safeInteger(change["linesDeleted"], "Lines deleted");
    if (typeof change["binary"] !== "boolean" || typeof change["generated"] !== "boolean") fail("File-change flags must be boolean.");
    if (change["generated"] === true) generated += 1;
  }
  if (patch["totalFilesModified"] !== paths.size || patch["generatedFilesModified"] !== generated || patch["linesAdded"] !== added || patch["linesDeleted"] !== deleted) fail("Patch aggregate counters do not match file changes.");
  hash(patch["finalDiffHash"], "Final diff hash");
  hash(patch["finalManifestHash"], "Final manifest hash");
  if (patch["baselineManifestHash"] !== undefined) hash(patch["baselineManifestHash"], "Baseline manifest hash");
  if (patch["evidenceAvailability"] !== undefined) oneOf(patch["evidenceAvailability"], ["available", "unavailable"], "Patch evidence availability");
  if (patch["evidenceAvailability"] === "unavailable" && (typeof patch["evidenceUnavailableReason"] !== "string" || (patch["evidenceUnavailableReason"] as string).trim().length === 0)) fail("Unavailable patch evidence needs a reason.");
  if (
    isRecord(finalizationOutcome) &&
    ((finalizationOutcome["status"] === "completed" &&
      patch["evidenceAvailability"] !== "available") ||
      (finalizationOutcome["status"] === "evidence_unavailable" &&
        patch["evidenceAvailability"] !== "unavailable"))
  ) {
    fail("Finalization outcome disagrees with patch-evidence availability.");
  }
  if (
    isRecord(agentOutcomeRaw) &&
    agentOutcomeRaw["shutdownConfirmed"] === false &&
    patch["evidenceAvailability"] !== "unavailable"
  ) {
    fail("Unconfirmed agent shutdown cannot have final workspace evidence.");
  }

  const evaluation = object(record["evaluation"], "Evaluation summary");
  const checks = validateChecks(evaluation["checks"], "evaluator");
  if (typeof evaluation["success"] !== "boolean") fail("Evaluation success must be boolean.");
  for (const key of ["failureCategory", "invalidRunReason"] as const) {
    if (evaluation[key] !== null && (typeof evaluation[key] !== "string" || (evaluation[key] as string).trim().length === 0)) fail(`Evaluation ${key} must be null or nonempty.`);
  }
  const derivedEvaluation = deriveEvaluationSummary({
    supplied: evaluation as unknown as RunRecord["evaluation"],
    mode,
    arm,
  });
  if (evaluation["success"] !== derivedEvaluation.success) fail("Evaluation success is not derived from named evaluator checks.");
  if (typeof record["finalSuccess"] !== "boolean") fail("Final success must be boolean.");
  const agentPassed = isRecord(agentOutcomeRaw)
    ? agentOutcomeRaw["status"] === "completed"
    : completionStatus === "completed";
  const evaluatorPassed = isRecord(evaluatorOutcome)
    ? evaluatorOutcome["status"] === "completed"
    : true;
  const finalizationPassed = isRecord(finalizationOutcome)
    ? finalizationOutcome["status"] === "completed"
    : true;
  const expectedFinal = agentPassed && (mode === "smoke" || provisioning.length > 0) && provisioning.every(({ status }) => status === "passed") && preflight.length > 0 && preflight.every(({ status }) => status === "passed") && evaluatorPassed && evaluation["success"] === true && finalizationPassed;
  if (record["finalSuccess"] !== expectedFinal) fail("Final success disagrees with agent, preflight, evaluator, or finalization outcomes.");
  if (
    isRecord(evaluatorOutcome) &&
    evaluatorOutcome["status"] !== "completed" &&
    evaluation["success"] === true
  ) {
    fail("A non-completed evaluator outcome cannot claim evaluation success.");
  }

  const artifacts = record["artifacts"];
  if (!Array.isArray(artifacts)) fail("Artifact manifest must be an array.");
  const artifactNames = new Set<string>();
  for (const raw of artifacts) {
    const artifact = object(raw, "Artifact record");
    const name = nonempty(artifact["name"], "Artifact name");
    try { normalizeWorkspacePath(name); } catch { fail(`Invalid artifact name: ${name}`); }
    if (artifactNames.has(name)) fail(`Duplicate artifact name: ${name}`);
    artifactNames.add(name);
    nonempty(artifact["mediaType"], "Artifact media type");
    if (!Number.isSafeInteger(artifact["bytes"]) || (artifact["bytes"] as number) < 0) fail("Artifact byte count is invalid.");
    hash(artifact["sha256"], "Artifact hash");
  }
}

export interface WrittenRunResult {
  readonly runDirectory: string;
  readonly recordPath: string;
  readonly completionPath: string;
  readonly record: RunRecord;
}

interface ParsedManifestArtifact {
  readonly hash: string;
  readonly files: readonly Record<string, unknown>[];
}

const manifestFromArtifact = (data: Buffer, name: string): ParsedManifestArtifact => {
  const parsed = object(parseJson(name, data.toString("utf8")), name);
  if (
    parsed["schemaVersion"] !== 1 ||
    !Array.isArray(parsed["excludedDirectoryNames"]) ||
    canonicalJson(parsed["excludedDirectoryNames"]) !==
      canonicalJson(SNAPSHOT_EXCLUDED_DIRECTORY_NAMES) ||
    !Array.isArray(parsed["files"])
  ) {
    fail(`${name} has invalid snapshot-exclusion or file-manifest semantics.`);
  }
  const files = parsed["files"] as unknown[];
  const paths = new Set<string>();
  let previous = "";
  const validated = files.map((raw) => {
    const entry = object(raw, `${name} entry`);
    const path = nonempty(entry["path"], `${name} path`);
    try { normalizeWorkspacePath(path); } catch { fail(`${name} contains an invalid path.`); }
    if (paths.has(path) || (previous.length > 0 && path.localeCompare(previous) <= 0)) {
      fail(`${name} paths must be unique and sorted.`);
    }
    paths.add(path);
    previous = path;
    if (!Number.isSafeInteger(entry["bytes"]) || (entry["bytes"] as number) < 0) {
      fail(`${name} entry has an invalid byte count.`);
    }
    if (!Number.isSafeInteger(entry["mode"]) || (entry["mode"] as number) < 0) {
      fail(`${name} entry has an invalid mode.`);
    }
    hash(entry["sha256"], `${name} entry hash`);
    return entry;
  });
  return {
    hash: sha256(canonicalJson({
      excludedDirectoryNames: parsed["excludedDirectoryNames"],
      files: validated,
    })),
    files: validated,
  };
};

const evidenceMetadata = (
  raw: unknown,
  name: string,
): Record<string, unknown> | null => {
  if (raw === null) return null;
  const value = object(raw, name);
  if (
    !Number.isSafeInteger(value["bytes"]) ||
    (value["bytes"] as number) < 0 ||
    !Number.isSafeInteger(value["mode"]) ||
    (value["mode"] as number) < 0 ||
    typeof value["contentBase64"] !== "string"
  ) {
    fail(`${name} has malformed byte evidence.`);
  }
  hash(value["sha256"], `${name} hash`);
  const bytes = Buffer.from(value["contentBase64"], "base64");
  if (
    bytes.byteLength !== value["bytes"] ||
    bytes.toString("base64") !== value["contentBase64"] ||
    sha256(bytes) !== value["sha256"]
  ) {
    fail(`${name} byte evidence disagrees with its metadata.`);
  }
  return {
    bytes: value["bytes"],
    mode: value["mode"],
    sha256: value["sha256"],
  };
};

const manifestMetadata = (
  entry: Record<string, unknown> | null,
): Record<string, unknown> | null => entry === null
  ? null
  : {
      bytes: entry["bytes"],
      mode: entry["mode"],
      sha256: entry["sha256"],
    };

const validateEvidenceArtifacts = (
  record: RunRecord,
  dataByName: ReadonlyMap<string, Buffer>,
): void => {
  if (record.mode !== "confirmatory") return;
  const required = (name: string): Buffer => {
    const data = dataByName.get(name);
    if (data === undefined) fail(`Confirmatory evidence artifact is missing: ${name}`);
    return data;
  };
  const initial = required("harness/initial-fixture-manifest.json");
  const baseline = required("harness/baseline-manifest.json");
  const scheduleData = required("harness/schedule.json");
  const cohortData = required("harness/cohort-manifest.json");
  if (
    record.confirmatoryEvidence === null ||
    record.confirmatoryEvidence === undefined
  ) {
    fail("Confirmatory evidence metadata is missing.");
  }
  const schedule = parseJson("Confirmatory schedule", scheduleData.toString("utf8"));
  const cohort = parseJson("Frozen cohort manifest", cohortData.toString("utf8"));
  try {
    validateScheduleDocument(schedule as ScheduleDocument);
    validateFrozenCohortManifest(cohort as FrozenCohortManifest);
  } catch (error: unknown) {
    fail(`Invalid frozen confirmatory artifact: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !isRecord(schedule) ||
    schedule["scheduleHash"] !== record.confirmatoryEvidence.scheduleHash ||
    sha256(canonicalJson(schedule)) !== record.confirmatoryEvidence.scheduleContentHash
  ) {
    fail("Schedule artifact disagrees with confirmatory evidence.");
  }
  if (
    !isRecord(cohort) ||
    cohort["manifestHash"] !== record.confirmatoryEvidence.cohortManifestHash
  ) {
    fail("Cohort artifact disagrees with confirmatory evidence.");
  }
  const typedSchedule = schedule as unknown as ScheduleDocument;
  const typedCohort = cohort as unknown as FrozenCohortManifest;
  const slot = typedSchedule.runs.find(
    ({ ordinal }) => ordinal === record.confirmatoryEvidence?.ordinal,
  );
  if (
    slot === undefined ||
    slot.blockId !== record.confirmatoryEvidence.blockId ||
    canonicalJson(slot.task) !== canonicalJson(record.identity.task) ||
    slot.arm !== record.identity.arm ||
    slot.repetition !== record.identity.repetition ||
    typedSchedule.seed !== record.identity.scheduleSeed ||
    typedCohort.scheduleHash !== typedSchedule.scheduleHash ||
    typedCohort.scheduleSeed !== typedSchedule.seed ||
    typedCohort.analysisRevision !== record.identity.analysisRevision ||
    typedCohort.provisioningConfigurationHash !==
      record.confirmatoryEvidence.provisioningConfigurationHash
  ) {
    fail("Frozen schedule/cohort artifacts do not bind the recorded run slot.");
  }
  const taskKey = `${record.identity.task.id}@${record.identity.task.version}`;
  if (
    typedCohort.instructionBundleByTask[taskKey] !== record.instructionHashes.bundle ||
    typedCohort.fixtureRevisionByTask[taskKey]?.[record.identity.arm] !==
      record.identity.fixtureRevision ||
    typedCohort.fixtureManifestHashByTask[taskKey]?.[record.identity.arm] !==
      record.confirmatoryEvidence.initialFixtureManifestHash ||
    typedCohort.evaluatorRevisionByTask[taskKey]?.[record.identity.arm] !==
      record.identity.evaluatorRevision ||
    typedCohort.provider !== record.provider ||
    typedCohort.exactModel !== record.model ||
    typedCohort.serviceTier !== record.serviceTier ||
    typedCohort.reasoningConfigurationHash !==
      sha256(canonicalJson(record.reasoningConfiguration)) ||
    typedCohort.timeoutMsByTask[taskKey] !== record.timeoutMs ||
    typedCohort.lifecycleTimeoutMs !== record.confirmatoryEvidence.lifecycleTimeoutMs ||
    typedCohort.shutdownTimeoutMs !== record.confirmatoryEvidence.shutdownTimeoutMs ||
    typedCohort.networkPolicy !== record.environment.networkPolicy ||
    typedCohort.dependencyCachePolicy !== record.environment.dependencyCachePolicy ||
    typedCohort.hostClass !== record.environment.hostClass ||
    typedCohort.containerImage !== record.environment.containerImage ||
    typedCohort.packageManager !== record.environment.packageManager ||
    typedCohort.toolVersionsHash !== record.confirmatoryEvidence.toolVersionsHash ||
    typedCohort.pricingSnapshotId !== record.cost.pricingSnapshotId ||
    typedCohort.pricingCurrency !== record.cost.currency
  ) {
    fail("Frozen cohort pins disagree with the recorded run configuration.");
  }
  if (
    manifestFromArtifact(initial, "Initial fixture manifest").hash !==
    record.confirmatoryEvidence.initialFixtureManifestHash
  ) {
    fail("Initial fixture manifest artifact disagrees with confirmatory evidence.");
  }
  const baselineManifest = manifestFromArtifact(
    baseline,
    "Measured baseline manifest",
  );
  if (
    baselineManifest.hash !==
    record.patch.baselineManifestHash
  ) {
    fail("Measured baseline manifest artifact disagrees with PatchSummary.");
  }
  if (record.patch.evidenceAvailability === "available") {
    const finalManifest = required("harness/final-manifest.json");
    const normalizedPatch = required("harness/normalized-patch.json");
    if (dataByName.has("harness/finalization-unavailable.json")) {
      fail("Available evidence cannot include an unavailable-evidence artifact.");
    }
    const finalWorkspaceManifest = manifestFromArtifact(
      finalManifest,
      "Final workspace manifest",
    );
    if (
      finalWorkspaceManifest.hash !==
      record.patch.finalManifestHash
    ) {
      fail("Final manifest artifact disagrees with PatchSummary.");
    }
    const parsedPatch = object(
      parseJson("Normalized patch", normalizedPatch.toString("utf8")),
      "Normalized patch",
    );
    if (parsedPatch["schemaVersion"] !== 1 || !Array.isArray(parsedPatch["files"])) {
      fail("Normalized patch artifact is malformed.");
    }
    if (sha256(normalizedPatch) !== record.patch.finalDiffHash) {
      fail("Normalized patch artifact disagrees with PatchSummary.");
    }
    const reconstructed = new Map(
      baselineManifest.files.map((entry) => [entry["path"] as string, entry]),
    );
    const summaryKinds = new Map(
      record.patch.filesModified.map(({ path, kind }) => [path, kind]),
    );
    const patchPaths = new Set<string>();
    for (const raw of parsedPatch["files"]) {
      const file = object(raw, "Normalized patch file");
      const path = nonempty(file["path"], "Normalized patch path");
      try { normalizeWorkspacePath(path); } catch { fail("Normalized patch path is invalid."); }
      if (patchPaths.has(path)) fail(`Duplicate normalized patch path: ${path}`);
      patchPaths.add(path);
      const before = evidenceMetadata(file["before"], `${path} before`);
      const after = evidenceMetadata(file["after"], `${path} after`);
      if (before === null && after === null) fail(`Normalized patch ${path} changes nothing.`);
      const baselineEntry = reconstructed.get(path) ?? null;
      if (canonicalJson(before) !== canonicalJson(manifestMetadata(baselineEntry))) {
        fail(`Normalized patch before evidence disagrees for ${path}.`);
      }
      const kind = before === null ? "added" : after === null ? "deleted" : "modified";
      if (summaryKinds.get(path) !== kind) {
        fail(`Normalized patch kind disagrees with PatchSummary for ${path}.`);
      }
      if (after === null) reconstructed.delete(path);
      else reconstructed.set(path, { path, ...after });
    }
    if (patchPaths.size !== summaryKinds.size) {
      fail("Normalized patch paths disagree with PatchSummary.");
    }
    const reconstructedFiles = [...reconstructed.values()].sort((left, right) =>
      (left["path"] as string).localeCompare(right["path"] as string),
    );
    if (canonicalJson(reconstructedFiles) !== canonicalJson(finalWorkspaceManifest.files)) {
      fail("Normalized patch does not reconstruct the final workspace manifest.");
    }
  } else if (record.patch.evidenceAvailability === "unavailable") {
    required("harness/finalization-unavailable.json");
    if (
      dataByName.has("harness/final-manifest.json") ||
      dataByName.has("harness/normalized-patch.json")
    ) {
      fail("Unavailable evidence cannot claim final manifest or patch artifacts.");
    }
  } else {
    fail("Confirmatory PatchSummary must declare evidence availability.");
  }
};

const correctionIdentityBinding = (record: RunRecord): unknown => ({
  schemaVersion: record.identity.schemaVersion,
  task: record.identity.task,
  arm: record.identity.arm,
  repetition: record.identity.repetition,
  scheduleSeed: record.identity.scheduleSeed,
  fixtureRevision: record.identity.fixtureRevision,
  evaluatorRevision: record.identity.evaluatorRevision,
  analysisRevision: record.identity.analysisRevision,
});

const confirmatoryCorrectionBinding = (record: RunRecord): unknown => {
  const evidence = record.confirmatoryEvidence;
  if (evidence === null || evidence === undefined) return null;
  return {
    scheduleHash: evidence.scheduleHash,
    scheduleContentHash: evidence.scheduleContentHash,
    ordinal: evidence.ordinal,
    blockId: evidence.blockId,
    cohortManifestHash: evidence.cohortManifestHash,
    initialFixtureManifestHash: evidence.initialFixtureManifestHash,
    provisioningConfigurationHash: evidence.provisioningConfigurationHash,
    lifecycleTimeoutMs: evidence.lifecycleTimeoutMs,
    shutdownTimeoutMs: evidence.shutdownTimeoutMs,
    toolVersionsHash: evidence.toolVersionsHash,
    approvalReference: evidence.approvalReference,
  };
};

const validateCorrectionRelationship = (
  replacement: RunRecord,
  superseded: RunRecord,
): void => {
  const correction = replacement.correction;
  if (correction === undefined) {
    fail("Correction provenance is missing from the replacement record.");
  }
  if (correction.supersededRunId !== superseded.identity.runId) {
    fail("Correction provenance resolves to a different superseded run.");
  }
  if (
    replacement.mode !== superseded.mode ||
    canonicalJson(correctionIdentityBinding(replacement)) !==
      canonicalJson(correctionIdentityBinding(superseded))
  ) {
    fail("A correction must preserve the superseded run's scheduled identity.");
  }
  if (
    replacement.mode === "confirmatory" &&
    canonicalJson(confirmatoryCorrectionBinding(replacement)) !==
      canonicalJson(confirmatoryCorrectionBinding(superseded))
  ) {
    fail("A confirmatory correction must preserve its frozen schedule and cohort binding.");
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isRecord(error) && error["code"] === "ENOENT") return false;
    throw error;
  }
};

const writeImmutableRunRecord = async (input: {
  readonly resultsRoot: string;
  readonly draft: StoredRunRecordDraft;
  readonly artifacts: readonly AgentArtifactInput[];
  readonly superseded?: ReadImmutableRunResult;
}): Promise<WrittenRunResult> => {
  const runId = input.draft.identity.runId;
  assertRunId(runId);
  const names = new Set<string>();
  const prepared = input.artifacts.map((artifact) => {
    const name = normalizeWorkspacePath(artifact.name);
    if (names.has(name)) fail(`Duplicate artifact name: ${name}`);
    names.add(name);
    if (artifact.mediaType.trim().length === 0) fail(`Artifact ${name} has an empty media type.`);
    const data = typeof artifact.data === "string" ? Buffer.from(artifact.data, "utf8") : Buffer.from(artifact.data);
    return { name, mediaType: artifact.mediaType, data };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const artifactRecords: ArtifactRecord[] = prepared.map(({ name, mediaType, data }) => ({
    name,
    mediaType,
    bytes: data.byteLength,
    sha256: sha256(data),
  }));
  const record: RunRecord = { ...input.draft, artifacts: artifactRecords };
  validateRunRecord(record, runId);
  if (record.correction !== undefined) {
    if (input.superseded === undefined) {
      fail("Correction records must be written through the correction-specific API.");
    }
    if (record.correction.supersededRecordSha256 !== input.superseded.recordSha256) {
      fail("Superseded record hash does not match the retained immutable record.");
    }
    validateCorrectionRelationship(record, input.superseded.record);
  } else if (input.superseded !== undefined) {
    fail("Correction provenance is required when a superseded record is supplied.");
  }
  validateEvidenceArtifacts(
    record,
    new Map(prepared.map(({ name, data }) => [name, data])),
  );
  const payloadSha256 = sha256(canonicalJson(record));
  const envelope = { format: RESULT_FORMAT, envelopeVersion: 1, payloadSha256, payload: record };
  const recordBytes = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
  const completion = {
    schemaVersion: 1,
    runId,
    recordSha256: sha256(recordBytes),
    artifactManifestSha256: sha256(canonicalJson(artifactRecords)),
  };

  await mkdir(input.resultsRoot, { recursive: true });
  const resultsRoot = await realpath(input.resultsRoot);
  const runDirectory = resolve(resultsRoot, runId);
  if (!within(resultsRoot, runDirectory)) fail("Result path escapes its root.");
  if (await pathExists(runDirectory)) throw new DuplicateRunIdError(runId);
  const staging = await mkdtemp(join(resultsRoot, `.staging-${runId}-`));
  try {
    const artifactsDirectory = join(staging, "artifacts");
    await mkdir(artifactsDirectory, { recursive: false });
    for (const artifact of prepared) {
      const artifactPath = resolve(artifactsDirectory, ...artifact.name.split("/"));
      if (!within(artifactsDirectory, artifactPath)) fail(`Artifact escapes its directory: ${artifact.name}`);
      await mkdir(resolve(artifactPath, ".."), { recursive: true });
      await writeFile(artifactPath, artifact.data, { flag: "wx" });
    }
    await writeFile(join(staging, "raw-result.json"), recordBytes, { flag: "wx" });
    await writeFile(join(staging, "complete.json"), `${canonicalJson(completion)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(staging, runDirectory);
    } catch (error: unknown) {
      if (isRecord(error) && (error["code"] === "EEXIST" || error["code"] === "ENOTEMPTY")) throw new DuplicateRunIdError(runId);
      throw error;
    }
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    runDirectory,
    recordPath: join(runDirectory, "raw-result.json"),
    completionPath: join(runDirectory, "complete.json"),
    record: deepFreeze(record),
  };
};

export const writeImmutableRunResult = async (input: {
  readonly resultsRoot: string;
  readonly draft: RunRecordDraft;
  readonly artifacts: readonly AgentArtifactInput[];
}): Promise<WrittenRunResult> => {
  if (Object.hasOwn(input.draft, "correction")) {
    fail("Use writeImmutableRunCorrection to create correction provenance.");
  }
  return writeImmutableRunRecord(input);
};

export const writeImmutableRunCorrection = async (input: {
  readonly resultsRoot: string;
  readonly draft: RunRecordDraft;
  readonly artifacts: readonly AgentArtifactInput[];
  readonly supersededRunId: string;
  readonly reason: string;
  readonly recordedAt: string;
}): Promise<WrittenRunResult> => {
  assertRunId(input.supersededRunId);
  if (Object.hasOwn(input.draft, "correction")) {
    fail("Correction provenance is derived by the immutable result store.");
  }
  let superseded: ReadImmutableRunResult;
  try {
    superseded = await readImmutableRunResultMetadata(
      input.resultsRoot,
      input.supersededRunId,
    );
  } catch (error: unknown) {
    if (error instanceof ResultIntegrityError) throw error;
    return fail("Superseded run result is missing or unreadable.");
  }
  const correction: RunCorrectionProvenance = {
    schemaVersion: 1,
    supersededRunId: input.supersededRunId,
    supersededRecordSha256: superseded.recordSha256,
    reason: input.reason,
    recordedAt: input.recordedAt,
  };
  return writeImmutableRunRecord({
    resultsRoot: input.resultsRoot,
    draft: { ...input.draft, correction },
    artifacts: input.artifacts,
    superseded,
  });
};

interface ReadImmutableRunResult {
  readonly record: RunRecord;
  readonly recordSha256: string;
}

const readImmutableRunResultAtRoot = async (
  resultsRoot: string,
  runId: string,
  ancestors: ReadonlySet<string>,
): Promise<ReadImmutableRunResult> => {
  assertRunId(runId);
  if (ancestors.has(runId)) {
    fail("Correction provenance contains a cycle.");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(runId);
  const runDirectory = resolve(resultsRoot, runId);
  if (!within(resultsRoot, runDirectory)) fail("Result path escapes its root.");
  let completionText: string;
  let recordBytes: Buffer;
  try {
    [completionText, recordBytes] = await Promise.all([
      readFile(join(runDirectory, "complete.json"), "utf8"),
      readFile(join(runDirectory, "raw-result.json")),
    ]);
  } catch {
    return fail("Run result is incomplete or truncated: completion artifacts are missing.");
  }
  const completion = object(parseJson("Completion marker", completionText), "Completion marker");
  const recordSha256 = sha256(recordBytes);
  if (completion["runId"] !== runId || completion["recordSha256"] !== recordSha256) fail("Run completion marker failed integrity checks.");
  const envelope = object(parseJson("Raw result", recordBytes.toString("utf8")), "Raw-result envelope");
  if (envelope["format"] !== RESULT_FORMAT || envelope["envelopeVersion"] !== 1 || typeof envelope["payloadSha256"] !== "string" || !isRecord(envelope["payload"])) fail("Malformed raw-result envelope.");
  const payload: unknown = envelope["payload"];
  if (envelope["payloadSha256"] !== sha256(canonicalJson(payload))) fail("Raw-result payload hash mismatch.");
  validateRunRecord(payload, runId);
  if (completion["artifactManifestSha256"] !== sha256(canonicalJson(payload.artifacts))) fail("Artifact manifest hash mismatch.");
  const artifactData = new Map<string, Buffer>();
  for (const artifact of payload.artifacts) {
    let data: Buffer;
    try {
      const name = normalizeWorkspacePath(artifact.name);
      const artifactPath = resolve(join(runDirectory, "artifacts"), ...name.split("/"));
      if (!within(join(runDirectory, "artifacts"), artifactPath)) fail("Artifact path escapes its directory.");
      data = await readFile(artifactPath);
    } catch (error: unknown) {
      if (error instanceof ResultIntegrityError) throw error;
      return fail(`Artifact is missing: ${artifact.name}`);
    }
    if (data.byteLength !== artifact.bytes || sha256(data) !== artifact.sha256) fail(`Artifact hash mismatch: ${artifact.name}`);
    artifactData.set(artifact.name, data);
  }
  validateEvidenceArtifacts(payload, artifactData);
  if (payload.correction !== undefined) {
    const superseded = await readImmutableRunResultAtRoot(
      resultsRoot,
      payload.correction.supersededRunId,
      nextAncestors,
    );
    if (payload.correction.supersededRecordSha256 !== superseded.recordSha256) {
      fail("Superseded record hash does not match the retained immutable record.");
    }
    validateCorrectionRelationship(payload, superseded.record);
  }
  return { record: deepFreeze(payload), recordSha256 };
};

const readImmutableRunResultMetadata = async (
  resultsRootInput: string,
  runId: string,
): Promise<ReadImmutableRunResult> => {
  const resultsRoot = await realpath(resultsRootInput);
  return readImmutableRunResultAtRoot(resultsRoot, runId, new Set());
};

export const readImmutableRunResult = async (
  resultsRootInput: string,
  runId: string,
): Promise<RunRecord> =>
  (await readImmutableRunResultMetadata(resultsRootInput, runId)).record;
