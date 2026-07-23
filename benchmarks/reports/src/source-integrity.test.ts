import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANALYSIS_RUNTIME_FILES,
  createExecutedAnalysisSourceManifest,
  serializeAnalysisSourceManifest,
  verifyExecutedAnalysisSourceManifest,
} from "./source-integrity.js";

const runtimeFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agentix-analysis-source-"));
  const directory = join(root, "benchmarks", "reports", "dist");
  const harnessDirectory = join(root, "benchmarks", "harness", "dist");
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(harnessDirectory, { recursive: true }),
  ]);
  await Promise.all(
    ANALYSIS_RUNTIME_FILES.map((path) => {
      const [owner, file] = path.split("/");
      if (file === undefined) throw new Error(`Malformed runtime path ${path}.`);
      return writeFile(
        join(owner === "reports" ? directory : harnessDirectory, file),
        `export const moduleName = ${JSON.stringify(path)};\n`,
      );
    }),
  );
  return directory;
};

describe("executing analysis-source integrity", () => {
  it("accepts a canonical manifest only when every exact runtime module matches", async () => {
    const runtimeDirectory = await runtimeFixture();
    const manifest = await createExecutedAnalysisSourceManifest(runtimeDirectory);
    const text = serializeAnalysisSourceManifest(manifest);
    await expect(
      verifyExecutedAnalysisSourceManifest({ text, runtimeDirectory }),
    ).resolves.toMatchObject({ manifest });
  });

  it("rejects a manifest that blesses bytes other than the executing analyzer", async () => {
    const runtimeDirectory = await runtimeFixture();
    const manifest = await createExecutedAnalysisSourceManifest(runtimeDirectory);
    const text = serializeAnalysisSourceManifest(manifest);
    await writeFile(join(runtimeDirectory, "analyze.js"), "export const tampered = true;\n");
    await expect(
      verifyExecutedAnalysisSourceManifest({ text, runtimeDirectory }),
    ).rejects.toThrow(/does not match its pinned hash/u);
  });
});
