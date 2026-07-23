import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256 } from "./hash.js";
import type { FileChange, PatchSummary } from "./types.js";

const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/u;
export const SNAPSHOT_EXCLUDED_DIRECTORY_NAMES = [
  "node_modules",
  ".cache",
  ".turbo",
  ".agentix",
] as const;

export class PathConfinementError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PathConfinementError";
  }
}

export class WorkspaceReuseError extends Error {
  public constructor(runId: string) {
    super(`Workspace for run ID ${runId} already exists.`);
    this.name = "WorkspaceReuseError";
  }
}

const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
};

export const normalizeWorkspacePath = (input: string): string => {
  if (input.length === 0 || isAbsolute(input) || input.includes("\0")) {
    throw new PathConfinementError(`Invalid workspace-relative path: ${input}`);
  }
  const portable = input.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new PathConfinementError(`Path escapes or aliases the workspace: ${input}`);
  }
  return segments.join("/");
};

export const resolveWorkspaceFile = (
  workspacePath: string,
  input: string,
): string => {
  const normalized = normalizeWorkspacePath(input);
  const candidate = resolve(workspacePath, ...normalized.split("/"));
  if (!isWithin(resolve(workspacePath), candidate)) {
    throw new PathConfinementError(`Path escapes the workspace: ${input}`);
  }
  return candidate;
};

const copyDirectory = async (source: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: false });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new PathConfinementError(
        `Fixture symbolic links are prohibited: ${sourcePath}`,
      );
    }
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new PathConfinementError(
        `Fixture contains an unsupported entry: ${sourcePath}`,
      );
    }
    await copyFile(sourcePath, destinationPath);
    const metadata = await lstat(sourcePath);
    await chmod(destinationPath, metadata.mode);
  }
};

export interface MaterializedWorkspace {
  readonly runDirectory: string;
  readonly workspacePath: string;
  readonly fixturePath: string;
}

export const materializeWorkspace = async (input: {
  readonly fixturesRoot: string;
  readonly fixtureRelativePath: string;
  readonly runsRoot: string;
  readonly runId: string;
}): Promise<MaterializedWorkspace> => {
  if (!SAFE_RUN_ID.test(input.runId) || input.runId === "." || input.runId === "..") {
    throw new PathConfinementError(`Unsafe run ID: ${input.runId}`);
  }
  await mkdir(input.runsRoot, { recursive: true });
  const fixturesRoot = await realpath(input.fixturesRoot);
  const lexicalFixture = resolve(fixturesRoot, input.fixtureRelativePath);
  if (!isWithin(fixturesRoot, lexicalFixture)) {
    throw new PathConfinementError("Fixture path escapes the fixtures root.");
  }
  const fixturePath = await realpath(lexicalFixture);
  if (!isWithin(fixturesRoot, fixturePath)) {
    throw new PathConfinementError("Fixture resolves outside the fixtures root.");
  }
  const fixtureMetadata = await lstat(fixturePath);
  if (!fixtureMetadata.isDirectory()) {
    throw new TypeError("A benchmark fixture must be a directory.");
  }

  const runsRoot = await realpath(input.runsRoot);
  if (isWithin(fixturePath, runsRoot) || isWithin(runsRoot, fixturePath)) {
    throw new PathConfinementError(
      "Fixture and run roots must be disjoint to prevent recursive or cross-run copying.",
    );
  }
  const runDirectory = resolve(runsRoot, input.runId);
  if (!isWithin(runsRoot, runDirectory)) {
    throw new PathConfinementError("Run directory escapes the runs root.");
  }
  try {
    await mkdir(runDirectory, { recursive: false });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new WorkspaceReuseError(input.runId);
    }
    throw error;
  }

  const workspacePath = join(runDirectory, "workspace");
  await copyDirectory(fixturePath, workspacePath);
  await writeFile(
    join(runDirectory, "workspace-origin.json"),
    `${canonicalJson({ fixturePath, runId: input.runId })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return { runDirectory, workspacePath, fixturePath };
};

export interface WorkspaceManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly sha256: string;
}

interface SnapshotFile extends WorkspaceManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly sha256: string;
  readonly binary: boolean;
  readonly text: string | null;
  readonly dataBase64: string;
}

export interface WorkspaceSnapshot {
  readonly files: ReadonlyMap<string, SnapshotFile>;
  readonly manifest: readonly WorkspaceManifestEntry[];
  readonly excludedDirectoryNames: readonly string[];
  readonly manifestHash: string;
}

const walkWorkspace = async (
  root: string,
  directory: string,
  files: SnapshotFile[],
): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (
      (entry.isDirectory() &&
        SNAPSHOT_EXCLUDED_DIRECTORY_NAMES.includes(
          entry.name as (typeof SNAPSHOT_EXCLUDED_DIRECTORY_NAMES)[number],
        )) ||
      (entry.isFile() && entry.name.endsWith(".tsbuildinfo"))
    ) {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new PathConfinementError(
        `Workspace symbolic links are prohibited: ${absolutePath}`,
      );
    }
    if (entry.isDirectory()) {
      await walkWorkspace(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new PathConfinementError(
        `Workspace contains an unsupported entry: ${absolutePath}`,
      );
    }
    const data = await readFile(absolutePath);
    const metadata = await lstat(absolutePath);
    const path = relative(root, absolutePath).split(sep).join("/");
    const binary = data.includes(0);
    files.push({
      path,
      bytes: data.byteLength,
      mode: metadata.mode,
      sha256: createHash("sha256").update(data).digest("hex"),
      binary,
      text: binary ? null : data.toString("utf8").replace(/\r\n?/gu, "\n"),
      dataBase64: data.toString("base64"),
    });
  }
};

export const snapshotWorkspace = async (
  workspacePath: string,
): Promise<WorkspaceSnapshot> => {
  const root = await realpath(workspacePath);
  const files: SnapshotFile[] = [];
  await walkWorkspace(root, root, files);
  const manifest = files.map(({ path, bytes, mode, sha256: hash }) => ({
    path,
    bytes,
    mode,
    sha256: hash,
  }));
  return {
    files: new Map(files.map((file) => [file.path, file])),
    manifest,
    excludedDirectoryNames: [...SNAPSHOT_EXCLUDED_DIRECTORY_NAMES],
    manifestHash: sha256(canonicalJson({
      excludedDirectoryNames: SNAPSHOT_EXCLUDED_DIRECTORY_NAMES,
      files: manifest,
    })),
  };
};

export const serializeWorkspaceManifest = (
  snapshot: WorkspaceSnapshot,
): string => `${canonicalJson({
  schemaVersion: 1,
  excludedDirectoryNames: snapshot.excludedDirectoryNames,
  files: snapshot.manifest,
})}\n`;

export const hashProtectedWorkspaceManifest = (
  snapshot: WorkspaceSnapshot,
  mutablePathPrefixes: readonly string[],
): string => {
  const prefixes = mutablePathPrefixes.map(normalizeWorkspacePath);
  const protectedManifest = snapshot.manifest.filter(({ path }) =>
    !path.endsWith(".tsbuildinfo") &&
    !prefixes.some((prefix) =>
      path === prefix ||
      path.startsWith(`${prefix}/`) ||
      (!prefix.includes("/") &&
        (path.endsWith(`/${prefix}`) || path.includes(`/${prefix}/`))),
    ),
  );
  return sha256(canonicalJson({
    excludedDirectoryNames: snapshot.excludedDirectoryNames,
    files: protectedManifest,
  }));
};

export const createNormalizedWorkspacePatch = (
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): string => {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const files = [...paths].sort().flatMap((path) => {
    const oldFile = before.files.get(path);
    const newFile = after.files.get(path);
    if (oldFile?.sha256 === newFile?.sha256 && oldFile?.mode === newFile?.mode) {
      return [];
    }
    const evidence = (file: SnapshotFile | undefined) =>
      file === undefined
        ? null
        : {
            bytes: file.bytes,
            mode: file.mode,
            sha256: file.sha256,
            contentBase64: file.dataBase64,
          };
    return [{ path, before: evidence(oldFile), after: evidence(newFile) }];
  });
  return `${canonicalJson({ schemaVersion: 1, files })}\n`;
};

const textLines = (text: string): readonly string[] => {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const lineDelta = (
  before: string,
  after: string,
): { readonly added: number; readonly deleted: number } => {
  const left = textLines(before);
  const right = textLines(after);
  if (left.length * right.length > 1_000_000) {
    return { added: right.length, deleted: left.length };
  }
  let previous = new Uint32Array(right.length + 1);
  for (const leftLine of left) {
    const current = new Uint32Array(right.length + 1);
    for (let index = 1; index <= right.length; index += 1) {
      current[index] =
        leftLine === right[index - 1]
          ? (previous[index - 1] ?? 0) + 1
          : Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
    }
    previous = current;
  }
  const common = previous[right.length] ?? 0;
  return { added: right.length - common, deleted: left.length - common };
};

export const diffWorkspaceSnapshots = (
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  generatedPathPrefixes: readonly string[] = [],
): PatchSummary => {
  const normalizedPatch = createNormalizedWorkspacePatch(before, after);
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldFile = before.files.get(path);
    const newFile = after.files.get(path);
    if (oldFile?.sha256 === newFile?.sha256 && oldFile?.mode === newFile?.mode) {
      continue;
    }
    const binary = oldFile?.binary === true || newFile?.binary === true;
    let linesAdded = 0;
    let linesDeleted = 0;
    if (!binary) {
      const delta = lineDelta(oldFile?.text ?? "", newFile?.text ?? "");
      linesAdded = delta.added;
      linesDeleted = delta.deleted;
    }
    changes.push({
      path,
      kind:
        oldFile === undefined
          ? "added"
          : newFile === undefined
            ? "deleted"
            : "modified",
      linesAdded,
      linesDeleted,
      binary,
      generated: generatedPathPrefixes.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      ),
    });
  }
  return {
    filesModified: changes,
    totalFilesModified: changes.length,
    generatedFilesModified: changes.filter(({ generated }) => generated).length,
    linesAdded: changes.reduce((total, change) => total + change.linesAdded, 0),
    linesDeleted: changes.reduce(
      (total, change) => total + change.linesDeleted,
      0,
    ),
    finalDiffHash: sha256(normalizedPatch),
    finalManifestHash: after.manifestHash,
    baselineManifestHash: before.manifestHash,
    evidenceAvailability: "available",
    evidenceUnavailableReason: null,
  };
};

export const isSourcePath = (path: string): boolean => SOURCE_EXTENSION.test(path);
