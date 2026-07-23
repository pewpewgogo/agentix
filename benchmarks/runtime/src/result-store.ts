import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";

import {
  validateRuntimeBenchmarkReport,
  type RuntimeBenchmarkReport,
} from "./benchmark.js";
import { canonicalJson, hashJson, SHA256_PATTERN, sha256 } from "./evidence.js";

export interface RuntimePublicationManifest {
  readonly schemaVersion: 1;
  readonly kind: "runtime-publication-manifest";
  readonly publicationId: string;
  readonly reportFile: "report.json";
  readonly reportSha256: string;
  readonly eligibleForConfirmatoryUse: boolean;
  readonly evidenceHashes: {
    readonly measurementPlanSha256: string;
    readonly packageLockSha256: string;
    readonly runtimeSourceManifestSha256: string;
    readonly applicationSourceManifestSha256: string;
    readonly processBuildEvidenceSha256: string;
  };
}

export interface RuntimePublicationCompletion {
  readonly schemaVersion: 1;
  readonly kind: "runtime-publication-complete";
  readonly publicationId: string;
  readonly manifestSha256: string;
  readonly reportSha256: string;
}

export interface RuntimePublication {
  readonly publicationId: string;
  readonly path: string;
  readonly reportSha256: string;
  readonly eligibleForConfirmatoryUse: boolean;
}

export interface ReadRuntimePublication {
  readonly report: RuntimeBenchmarkReport;
  readonly manifest: RuntimePublicationManifest;
  readonly completion: RuntimePublicationCompletion;
}

export class DuplicateRuntimePublicationError extends Error {
  override readonly name = "DuplicateRuntimePublicationError";
}

export class RuntimePublicationIntegrityError extends Error {
  override readonly name = "RuntimePublicationIntegrityError";
}

const publicationIdPattern = /^runtime-[a-f0-9]{64}$/u;

const evidenceHashesFor = (
  report: RuntimeBenchmarkReport,
): RuntimePublicationManifest["evidenceHashes"] => ({
  measurementPlanSha256: report.evidence.measurementPlanSha256,
  packageLockSha256: report.repository.packageLockSha256,
  runtimeSourceManifestSha256: report.repository.runtimeSourceManifestSha256,
  applicationSourceManifestSha256: report.repository.applicationSourceManifestSha256,
  processBuildEvidenceSha256: hashJson(report.evidence.processBuilds),
});

const writeExclusiveCanonical = async (
  path: string,
  value: unknown,
): Promise<string> => {
  const content = canonicalJson(value);
  const handle = await open(path, "wx", 0o444);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return content;
};

const syncDirectoryBestEffort = async (path: string): Promise<void> => {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms do not permit opening directories. File fsync and atomic
    // same-directory rename still provide the portable part of the protocol.
  }
};

const isAlreadyExists = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause &&
  (cause as { readonly code?: unknown }).code === "EEXIST";

export const publishRuntimeReport = async (input: {
  readonly resultsRoot: string;
  readonly report: RuntimeBenchmarkReport;
}): Promise<RuntimePublication> => {
  validateRuntimeBenchmarkReport(input.report);
  const reportContent = canonicalJson(input.report);
  const reportValue: unknown = JSON.parse(reportContent);
  validateRuntimeBenchmarkReport(reportValue);
  // Publish the detached canonical snapshot so caller mutation across awaits
  // cannot produce a manifest that refers to different evidence than the file.
  const report = reportValue;
  const reportSha256 = sha256(reportContent);
  const publicationId = `runtime-${reportSha256}`;

  await mkdir(resolve(input.resultsRoot), { recursive: true });
  const resultsRoot = await realpath(resolve(input.resultsRoot));
  const publicationPath = resolve(resultsRoot, publicationId);
  const lockPath = resolve(resultsRoot, `${publicationId}.lock.json`);
  const stagingPath = resolve(
    resultsRoot,
    `.partial-${publicationId}-${randomUUID()}`,
  );
  const lock = Object.freeze({
    schemaVersion: 1,
    kind: "runtime-publication-lock",
    publicationId,
    reportSha256,
  });

  try {
    await writeExclusiveCanonical(lockPath, lock);
  } catch (cause: unknown) {
    if (isAlreadyExists(cause)) {
      throw new DuplicateRuntimePublicationError(
        `Runtime publication ${publicationId} already exists or is reserved.`,
      );
    }
    throw cause;
  }

  let published = false;
  try {
    await mkdir(stagingPath, { mode: 0o700 });
    const writtenReport = await writeExclusiveCanonical(
      resolve(stagingPath, "report.json"),
      report,
    );
    if (writtenReport !== reportContent) {
      throw new RuntimePublicationIntegrityError(
        "Canonical report changed during publication.",
      );
    }
    const manifest: RuntimePublicationManifest = Object.freeze({
      schemaVersion: 1,
      kind: "runtime-publication-manifest",
      publicationId,
      reportFile: "report.json",
      reportSha256,
      eligibleForConfirmatoryUse: report.eligibility.confirmatory,
      evidenceHashes: Object.freeze(evidenceHashesFor(report)),
    });
    const manifestContent = await writeExclusiveCanonical(
      resolve(stagingPath, "manifest.json"),
      manifest,
    );
    const completion: RuntimePublicationCompletion = Object.freeze({
      schemaVersion: 1,
      kind: "runtime-publication-complete",
      publicationId,
      manifestSha256: sha256(manifestContent),
      reportSha256,
    });
    // Written last: readers never treat a directory without this marker as sealed.
    await writeExclusiveCanonical(resolve(stagingPath, "complete.json"), completion);
    await syncDirectoryBestEffort(stagingPath);
    await rename(stagingPath, publicationPath);
    published = true;
    // macOS refuses renaming a directory after removing owner write access, so
    // make it read-only immediately after the atomic same-directory rename.
    await chmod(publicationPath, 0o555);
    await syncDirectoryBestEffort(resultsRoot);
    return Object.freeze({
      publicationId,
      path: publicationPath,
      reportSha256,
      eligibleForConfirmatoryUse: report.eligibility.confirmatory,
    });
  } finally {
    if (!published) {
      await chmod(stagingPath, 0o700).catch(() => undefined);
      await rm(stagingPath, { recursive: true, force: true });
      await unlink(lockPath).catch(() => undefined);
    }
  }
};

const readRegularFile = async (path: string): Promise<string> => {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause: unknown) {
    throw new RuntimePublicationIntegrityError(
      `Sealed runtime publication is incomplete: ${path}.`,
      { cause },
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RuntimePublicationIntegrityError(
      `Sealed runtime publication contains a non-regular file: ${path}.`,
    );
  }
  return readFile(path, "utf8");
};

const parseCanonical = (name: string, content: string): unknown => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause: unknown) {
    throw new RuntimePublicationIntegrityError(`${name} is not valid JSON.`, { cause });
  }
  if (canonicalJson(value) !== content) {
    throw new RuntimePublicationIntegrityError(`${name} is not canonical JSON.`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  name: string,
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void => {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new RuntimePublicationIntegrityError(
      `${name} contains missing or unexpected fields.`,
    );
  }
};

const validateDigest = (name: string, value: unknown): string => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new RuntimePublicationIntegrityError(`${name} is not a SHA-256 digest.`);
  }
  return value;
};

const validateManifest = (
  value: unknown,
  publicationId: string,
  report: RuntimeBenchmarkReport,
  reportSha256: string,
): RuntimePublicationManifest => {
  if (!isRecord(value)) {
    throw new RuntimePublicationIntegrityError("Runtime publication manifest is inconsistent.");
  }
  assertExactKeys("Runtime publication manifest", value, [
    "schemaVersion", "kind", "publicationId", "reportFile", "reportSha256",
    "eligibleForConfirmatoryUse", "evidenceHashes",
  ]);
  if (value["schemaVersion"] !== 1 ||
      value["kind"] !== "runtime-publication-manifest" ||
      value["publicationId"] !== publicationId || value["reportFile"] !== "report.json" ||
      value["reportSha256"] !== reportSha256 ||
      value["eligibleForConfirmatoryUse"] !== report.eligibility.confirmatory ||
      !isRecord(value["evidenceHashes"])) {
    throw new RuntimePublicationIntegrityError("Runtime publication manifest is inconsistent.");
  }
  const evidence = value["evidenceHashes"];
  assertExactKeys("Runtime publication evidence hashes", evidence, [
    "measurementPlanSha256", "packageLockSha256", "runtimeSourceManifestSha256",
    "applicationSourceManifestSha256", "processBuildEvidenceSha256",
  ]);
  const expected = evidenceHashesFor(report);
  for (const key of [
    "measurementPlanSha256",
    "packageLockSha256",
    "runtimeSourceManifestSha256",
    "applicationSourceManifestSha256",
    "processBuildEvidenceSha256",
  ] as const) {
    const digest = validateDigest(`manifest.${key}`, evidence[key]);
    if (digest !== expected[key]) {
      throw new RuntimePublicationIntegrityError(
        `Runtime publication evidence hash ${key} is inconsistent.`,
      );
    }
  }
  return value as unknown as RuntimePublicationManifest;
};

const validateCompletion = (
  value: unknown,
  publicationId: string,
  manifestSha256: string,
  reportSha256: string,
): RuntimePublicationCompletion => {
  if (!isRecord(value)) {
    throw new RuntimePublicationIntegrityError(
      "Runtime publication completion marker is inconsistent.",
    );
  }
  assertExactKeys("Runtime publication completion marker", value, [
    "schemaVersion", "kind", "publicationId", "manifestSha256", "reportSha256",
  ]);
  if (value["schemaVersion"] !== 1 ||
      value["kind"] !== "runtime-publication-complete" ||
      value["publicationId"] !== publicationId ||
      value["manifestSha256"] !== manifestSha256 ||
      value["reportSha256"] !== reportSha256) {
    throw new RuntimePublicationIntegrityError(
      "Runtime publication completion marker is inconsistent.",
    );
  }
  return value as unknown as RuntimePublicationCompletion;
};

export const readRuntimePublication = async (
  resultsRootInput: string,
  publicationId: string,
): Promise<ReadRuntimePublication> => {
  if (!publicationIdPattern.test(publicationId)) {
    throw new RuntimePublicationIntegrityError("Runtime publication ID is invalid.");
  }
  const resultsRoot = await realpath(resolve(resultsRootInput));
  const publicationPath = resolve(resultsRoot, publicationId);
  const publicationMetadata = await lstat(publicationPath).catch((cause: unknown) => {
    throw new RuntimePublicationIntegrityError(
      `Runtime publication ${publicationId} does not exist.`,
      { cause },
    );
  });
  if (!publicationMetadata.isDirectory() || publicationMetadata.isSymbolicLink()) {
    throw new RuntimePublicationIntegrityError("Runtime publication path is not a directory.");
  }
  const entries = (await readdir(publicationPath)).sort();
  if (canonicalJson(entries) !== canonicalJson([
    "complete.json", "manifest.json", "report.json",
  ])) {
    throw new RuntimePublicationIntegrityError(
      "Runtime publication contains missing or unexpected files.",
    );
  }

  const [reportContent, manifestContent, completionContent, lockContent] = await Promise.all([
    readRegularFile(resolve(publicationPath, "report.json")),
    readRegularFile(resolve(publicationPath, "manifest.json")),
    readRegularFile(resolve(publicationPath, "complete.json")),
    readRegularFile(resolve(resultsRoot, `${publicationId}.lock.json`)),
  ]);
  const reportValue = parseCanonical("report.json", reportContent);
  try {
    validateRuntimeBenchmarkReport(reportValue);
  } catch (cause: unknown) {
    throw new RuntimePublicationIntegrityError(
      "Runtime report failed schema or evidence validation.",
      { cause },
    );
  }
  const report = reportValue;
  const reportSha256 = sha256(reportContent);
  if (publicationId !== `runtime-${reportSha256}`) {
    throw new RuntimePublicationIntegrityError(
      "Runtime publication ID does not content-address report.json.",
    );
  }
  const manifestValue = parseCanonical("manifest.json", manifestContent);
  const manifest = validateManifest(
    manifestValue,
    publicationId,
    report,
    reportSha256,
  );
  const completion = validateCompletion(
    parseCanonical("complete.json", completionContent),
    publicationId,
    sha256(manifestContent),
    reportSha256,
  );
  const lockValue = parseCanonical("publication lock", lockContent);
  if (!isRecord(lockValue)) {
    throw new RuntimePublicationIntegrityError("Runtime publication lock is inconsistent.");
  }
  assertExactKeys("Runtime publication lock", lockValue, [
    "schemaVersion", "kind", "publicationId", "reportSha256",
  ]);
  if (lockValue["schemaVersion"] !== 1 ||
      lockValue["kind"] !== "runtime-publication-lock" ||
      lockValue["publicationId"] !== publicationId ||
      lockValue["reportSha256"] !== reportSha256) {
    throw new RuntimePublicationIntegrityError("Runtime publication lock is inconsistent.");
  }
  return Object.freeze({ report, manifest, completion });
};
