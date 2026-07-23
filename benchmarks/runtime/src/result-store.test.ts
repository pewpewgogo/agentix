import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runRuntimeBenchmark, type RuntimeBenchmarkReport } from "./benchmark.js";
import { canonicalJson, hashJson } from "./evidence.js";
import {
  DuplicateRuntimePublicationError,
  publishRuntimeReport,
  readRuntimePublication,
  RuntimePublicationIntegrityError,
} from "./result-store.js";

const roots: string[] = [];
let report: RuntimeBenchmarkReport;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "agentix-runtime-results-test-"));
  roots.push(root);
  return root;
};

const makeWritable = async (path: string): Promise<void> => {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o755);
    for (const entry of await readdir(path)) {
      await makeWritable(resolve(path, entry));
    }
  } else {
    await chmod(path, 0o644);
  }
};

beforeAll(async () => {
  report = await runRuntimeBenchmark({
    repositoryRoot,
    mode: "smoke",
    seed: "publication-test",
    warmupIterations: 0,
    measuredIterations: 1,
    toolchainIterations: 1,
    includeProcessMetrics: false,
    includeToolchainMetrics: false,
    now: () => "2040-01-01T00:00:00.000Z",
  });
});

afterAll(async () => {
  for (const root of roots) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("sealed runtime result publication", () => {
  it("publishes create-only content-addressed evidence and verifies every hash", async () => {
    const resultsRoot = await temporaryRoot();
    const publication = await publishRuntimeReport({ resultsRoot, report });
    expect(publication.publicationId).toBe(`runtime-${hashJson(report)}`);
    expect(publication.eligibleForConfirmatoryUse).toBe(false);

    const sealed = await readRuntimePublication(resultsRoot, publication.publicationId);
    expect(sealed.report).toEqual(report);
    expect(sealed.manifest.reportSha256).toBe(hashJson(report));
    expect(sealed.manifest.evidenceHashes).toEqual({
      measurementPlanSha256: report.evidence.measurementPlanSha256,
      packageLockSha256: report.repository.packageLockSha256,
      runtimeSourceManifestSha256: report.repository.runtimeSourceManifestSha256,
      applicationSourceManifestSha256: report.repository.applicationSourceManifestSha256,
      processBuildEvidenceSha256: hashJson(report.evidence.processBuilds),
    });
    expect((await lstat(publication.path)).mode & 0o222).toBe(0);

    await expect(publishRuntimeReport({ resultsRoot, report })).rejects.toBeInstanceOf(
      DuplicateRuntimePublicationError,
    );
  });

  it("allows exactly one publisher to reserve a content address", async () => {
    const resultsRoot = await temporaryRoot();
    const attempts = await Promise.allSettled([
      publishRuntimeReport({ resultsRoot, report }),
      publishRuntimeReport({ resultsRoot, report }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(DuplicateRuntimePublicationError),
    });
  });

  it("rejects report and completion-marker tampering", async () => {
    const reportRoot = await temporaryRoot();
    const reportPublication = await publishRuntimeReport({ resultsRoot: reportRoot, report });
    await chmod(reportPublication.path, 0o755);
    const reportPath = resolve(reportPublication.path, "report.json");
    await chmod(reportPath, 0o644);
    const changed = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    changed["generatedAt"] = "2040-01-02T00:00:00.000Z";
    await writeFile(reportPath, canonicalJson(changed));
    await expect(readRuntimePublication(
      reportRoot,
      reportPublication.publicationId,
    )).rejects.toBeInstanceOf(RuntimePublicationIntegrityError);

    const completionRoot = await temporaryRoot();
    const completionPublication = await publishRuntimeReport({
      resultsRoot: completionRoot,
      report,
    });
    await chmod(completionPublication.path, 0o755);
    const completionPath = resolve(completionPublication.path, "complete.json");
    await chmod(completionPath, 0o644);
    const completion = JSON.parse(
      await readFile(completionPath, "utf8"),
    ) as Record<string, unknown>;
    completion["manifestSha256"] = "0".repeat(64);
    await writeFile(completionPath, canonicalJson(completion));
    await expect(readRuntimePublication(
      completionRoot,
      completionPublication.publicationId,
    )).rejects.toBeInstanceOf(RuntimePublicationIntegrityError);
  });

  it("rejects a partial directory without its completion marker", async () => {
    const resultsRoot = await temporaryRoot();
    const publicationId = `runtime-${"0".repeat(64)}`;
    const partial = resolve(resultsRoot, publicationId);
    await mkdir(partial);
    await writeFile(resolve(partial, "report.json"), canonicalJson(report));
    await expect(readRuntimePublication(resultsRoot, publicationId)).rejects.toThrow(
      /missing or unexpected files|incomplete/u,
    );
  });
});
