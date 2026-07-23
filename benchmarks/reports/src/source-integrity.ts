import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson, sha256 } from "@agentix/benchmark-harness";

import { ANALYSIS_VERSION } from "./validation.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export const ANALYSIS_RUNTIME_FILES = Object.freeze([
  "reports/analyze.js",
  "reports/cli.js",
  "reports/index.js",
  "reports/publication.js",
  "reports/render.js",
  "reports/source-integrity.js",
  "reports/statistics.js",
  "reports/types.js",
  "reports/validation.js",
  "harness/cohort.js",
  "harness/evaluation.js",
  "harness/hash.js",
  "harness/index.js",
  "harness/pricing.js",
  "harness/provisioning.js",
  "harness/result-store.js",
  "harness/runner.js",
  "harness/schedule.js",
  "harness/scripted-adapter.js",
  "harness/telemetry.js",
  "harness/types.js",
  "harness/workspace.js",
] as const);

export interface AnalysisSourceFile {
  readonly path: string;
  readonly sha256: string;
}

export interface AnalysisSourceManifest {
  readonly schemaVersion: 1;
  readonly analysisVersion: typeof ANALYSIS_VERSION;
  readonly files: readonly AnalysisSourceFile[];
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${label} has unexpected or missing fields.`);
  }
};

export const parseAnalysisSourceManifest = (
  value: unknown,
): AnalysisSourceManifest => {
  const root = object(value, "analysis source manifest");
  exactKeys(root, ["schemaVersion", "analysisVersion", "files"], "analysis source manifest");
  if (root["schemaVersion"] !== 1 || root["analysisVersion"] !== ANALYSIS_VERSION) {
    throw new TypeError("Analysis source manifest schema/version mismatch.");
  }
  if (!Array.isArray(root["files"])) {
    throw new TypeError("analysis source manifest files must be an array.");
  }
  const files = root["files"].map((entry, index): AnalysisSourceFile => {
    const file = object(entry, `analysis source file ${index}`);
    exactKeys(file, ["path", "sha256"], `analysis source file ${index}`);
    const path = file["path"];
    const digest = file["sha256"];
    if (typeof path !== "string" || typeof digest !== "string" || !SHA256.test(digest)) {
      throw new TypeError(`analysis source file ${index} is malformed.`);
    }
    return Object.freeze({ path, sha256: digest });
  });
  const paths = files.map(({ path }) => path);
  if (
    paths.length !== ANALYSIS_RUNTIME_FILES.length ||
    paths.some((path, index) => path !== ANALYSIS_RUNTIME_FILES[index])
  ) {
    throw new TypeError(
      "Analysis source manifest must contain the exact ordered runtime module set.",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    analysisVersion: ANALYSIS_VERSION,
    files: Object.freeze(files),
  });
};

export const createExecutedAnalysisSourceManifest = async (
  runtimeDirectoryInput: string,
): Promise<AnalysisSourceManifest> => {
  const runtimeDirectory = resolve(runtimeDirectoryInput);
  const sourcePath = (path: string): string => {
    const separator = path.indexOf("/");
    const owner = path.slice(0, separator);
    const file = path.slice(separator + 1);
    return owner === "reports"
      ? join(runtimeDirectory, file)
      : join(runtimeDirectory, "..", "..", "harness", "dist", file);
  };
  const files = await Promise.all(
    ANALYSIS_RUNTIME_FILES.map(async (path): Promise<AnalysisSourceFile> => ({
      path,
      sha256: sha256(await readFile(sourcePath(path))),
    })),
  );
  return Object.freeze({
    schemaVersion: 1,
    analysisVersion: ANALYSIS_VERSION,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
};

export const serializeAnalysisSourceManifest = (
  manifest: AnalysisSourceManifest,
): string => canonicalJson(parseAnalysisSourceManifest(manifest));

export const verifyExecutedAnalysisSourceManifest = async (input: {
  readonly text: string;
  readonly runtimeDirectory: string;
}): Promise<{
  readonly manifest: AnalysisSourceManifest;
  readonly manifestHash: string;
}> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text) as unknown;
  } catch {
    throw new TypeError("Analysis source manifest is not valid JSON.");
  }
  const manifest = parseAnalysisSourceManifest(parsed);
  const canonical = serializeAnalysisSourceManifest(manifest);
  if (input.text !== canonical) {
    throw new TypeError("Analysis source manifest must use the canonical byte encoding.");
  }
  const observed = await createExecutedAnalysisSourceManifest(input.runtimeDirectory);
  for (let index = 0; index < observed.files.length; index += 1) {
    const expectedFile = manifest.files[index];
    const observedFile = observed.files[index];
    if (
      expectedFile === undefined ||
      observedFile === undefined ||
      expectedFile.path !== observedFile.path ||
      expectedFile.sha256 !== observedFile.sha256
    ) {
      throw new TypeError(
        `Executing analysis module ${observedFile?.path ?? index} does not match its pinned hash.`,
      );
    }
  }
  return Object.freeze({ manifest, manifestHash: sha256(canonical) });
};
