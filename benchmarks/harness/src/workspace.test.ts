import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createNormalizedWorkspacePatch,
  diffWorkspaceSnapshots,
  materializeWorkspace,
  PathConfinementError,
  resolveWorkspaceFile,
  snapshotWorkspace,
  WorkspaceReuseError,
} from "./workspace.js";

const fixtureRoots = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentix-workspace-"));
  const fixtures = join(root, "fixtures");
  const runs = join(root, "runs");
  const fixture = join(fixtures, "fixture-v1");
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(join(fixture, "src", "value.ts"), "export const value = 1;\n");
  return { root, fixtures, runs, fixture };
};

describe("isolated workspaces", () => {
  it("materializes fresh copies and refuses cross-run reuse", async () => {
    const paths = await fixtureRoots();
    const first = await materializeWorkspace({
      fixturesRoot: paths.fixtures,
      fixtureRelativePath: "fixture-v1",
      runsRoot: paths.runs,
      runId: "run-001",
    });
    const second = await materializeWorkspace({
      fixturesRoot: paths.fixtures,
      fixtureRelativePath: "fixture-v1",
      runsRoot: paths.runs,
      runId: "run-002",
    });
    await writeFile(join(first.workspacePath, "src", "value.ts"), "changed\n");
    await expect(
      readFile(join(second.workspacePath, "src", "value.ts"), "utf8"),
    ).resolves.toBe("export const value = 1;\n");

    await expect(
      materializeWorkspace({
        fixturesRoot: paths.fixtures,
        fixtureRelativePath: "fixture-v1",
        runsRoot: paths.runs,
        runId: "run-001",
      }),
    ).rejects.toBeInstanceOf(WorkspaceReuseError);
  });

  it("rejects traversal, unsafe IDs, and fixture symbolic links", async () => {
    const paths = await fixtureRoots();
    await expect(
      materializeWorkspace({
        fixturesRoot: paths.fixtures,
        fixtureRelativePath: "../outside",
        runsRoot: paths.runs,
        runId: "run-001",
      }),
    ).rejects.toBeInstanceOf(PathConfinementError);
    await expect(
      materializeWorkspace({
        fixturesRoot: paths.fixtures,
        fixtureRelativePath: "fixture-v1",
        runsRoot: paths.runs,
        runId: "../run-001",
      }),
    ).rejects.toBeInstanceOf(PathConfinementError);
    expect(() => resolveWorkspaceFile(paths.fixture, "../secret")).toThrow(
      PathConfinementError,
    );

    await symlink(paths.root, join(paths.fixture, "escape"));
    await expect(
      materializeWorkspace({
        fixturesRoot: paths.fixtures,
        fixtureRelativePath: "fixture-v1",
        runsRoot: paths.runs,
        runId: "run-symlink",
      }),
    ).rejects.toBeInstanceOf(PathConfinementError);
  });

  it("derives normalized final file and line changes from snapshots", async () => {
    const paths = await fixtureRoots();
    const workspace = await materializeWorkspace({
      fixturesRoot: paths.fixtures,
      fixtureRelativePath: "fixture-v1",
      runsRoot: paths.runs,
      runId: "run-diff",
    });
    const before = await snapshotWorkspace(workspace.workspacePath);
    await writeFile(
      join(workspace.workspacePath, "src", "value.ts"),
      "export const value = 2;\nexport const extra = true;\n",
    );
    await mkdir(join(workspace.workspacePath, "generated"));
    await writeFile(join(workspace.workspacePath, "generated", "index.ts"), "x\n");
    await mkdir(join(workspace.workspacePath, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(workspace.workspacePath, "node_modules", "ignored", "index.js"), "large cache\n");
    const after = await snapshotWorkspace(workspace.workspacePath);
    const patch = diffWorkspaceSnapshots(before, after, ["generated"]);
    const exactPatch = JSON.parse(createNormalizedWorkspacePatch(before, after)) as {
      readonly files: ReadonlyArray<{
        readonly path: string;
        readonly after: { readonly contentBase64: string } | null;
      }>;
    };

    expect(patch).toMatchObject({
      totalFilesModified: 2,
      generatedFilesModified: 1,
      linesAdded: 3,
      linesDeleted: 1,
    });
    expect(patch.finalDiffHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(patch.finalManifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(patch.filesModified).toContainEqual({
      path: "src/value.ts",
      kind: "modified",
      linesAdded: 2,
      linesDeleted: 1,
      binary: false,
      generated: false,
    });
    expect(after.files.has("node_modules/ignored/index.js")).toBe(false);
    expect(after.excludedDirectoryNames).toContain("node_modules");
    const valueEvidence = exactPatch.files.find(({ path }) => path === "src/value.ts");
    expect(Buffer.from(valueEvidence?.after?.contentBase64 ?? "", "base64").toString("utf8"))
      .toBe("export const value = 2;\nexport const extra = true;\n");
  });
});
