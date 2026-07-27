import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import { promisify } from "node:util";

const repositoryRoot = resolve(process.argv[2] ?? process.cwd());
const execFileAsync = promisify(execFile);
const frozenV2SourceCommit = "4745d33c07b2c4a9cefddf1e0ee53b46566af730";
const maxGitBlobBytes = 64 * 1024 * 1024;
const fromRoot = (path) => resolve(repositoryRoot, path);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = async (path) => sha256(await readFile(fromRoot(path)));
const readJson = async (path) => JSON.parse(await readFile(fromRoot(path), "utf8"));
const writeJson = async (path, value) => {
  await writeFile(fromRoot(path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
const runGit = async (arguments_) => {
  const { stdout } = await execFileAsync(
    "git",
    ["--no-replace-objects", "-C", repositoryRoot, ...arguments_],
    { encoding: null, maxBuffer: maxGitBlobBytes },
  );
  return stdout;
};
const assertNormalizedGitPath = (path) => {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\n") ||
    path.includes("\r") ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    posix.normalize(path) !== path ||
    path === ".." ||
    path.startsWith("../")
  ) {
    throw new TypeError(`Unsafe repository-relative Git path: ${path}`);
  }
};
const readFrozenV2Blob = async (path) => {
  assertNormalizedGitPath(path);
  return runGit(["cat-file", "blob", `${frozenV2SourceCommit}:${path}`]);
};

const basePath = "benchmarks/fixtures/v2/base.repository.json";
const base = await readJson(basePath);
if (base.id !== "agentix-commerce-app-base" || base.version !== 2) {
  throw new Error(`Refusing to refresh unexpected base inventory ${base.id}@${base.version}.`);
}
if (base.sourceRevision?.commit !== frozenV2SourceCommit) {
  throw new Error(
    `Refusing to refresh v2 inventory from ${base.sourceRevision?.commit ?? "no commit"}; expected ${frozenV2SourceCommit}.`,
  );
}
const sourceObjectType = (await runGit(["cat-file", "-t", frozenV2SourceCommit]))
  .toString("utf8")
  .trim();
if (sourceObjectType !== "commit") {
  throw new Error(
    `Frozen v2 source revision ${frozenV2SourceCommit} is ${sourceObjectType}, not a commit.`,
  );
}
for (const entry of base.entries) {
  entry.sha256 = sha256(await readFrozenV2Blob(entry.source));
}
await writeJson(basePath, base);
const baseSha256 = await digest(basePath);

const fixturePaths = [];
const fixtureRoot = "benchmarks/fixtures/v2";
for (const directory of (await readdir(fromRoot(fixtureRoot), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("task-"))
  .sort((left, right) => left.name.localeCompare(right.name))) {
  const relativeDirectory = `${fixtureRoot}/${directory.name}`;
  for (const file of (await readdir(fromRoot(relativeDirectory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".fixture.json"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = `${relativeDirectory}/${file.name}`;
    const fixture = await readJson(path);
    fixture.baseInventory.sha256 = baseSha256;
    for (const overlay of fixture.overlay.files) {
      overlay.sha256 = await digest(overlay.source);
    }
    await writeJson(path, fixture);
    fixturePaths.push(path);
  }
}
if (fixturePaths.length !== 20) {
  throw new Error(`Expected 20 fixture manifests, received ${fixturePaths.length}.`);
}

const taskDirectory = "benchmarks/tasks/v2";
const taskPaths = (await readdir(fromRoot(taskDirectory)))
  .filter((name) => name.endsWith(".task.json"))
  .sort()
  .map((name) => `${taskDirectory}/${name}`);
if (taskPaths.length !== 10) {
  throw new Error(`Expected 10 task specifications, received ${taskPaths.length}.`);
}
for (const path of taskPaths) {
  const task = await readJson(path);
  for (const implementation of ["framework", "plain"]) {
    task.fixture[implementation].sha256 = await digest(
      task.fixture[implementation].manifest,
    );
  }
  task.evaluator.hiddenManifestSha256 = await digest(task.evaluator.hiddenManifest);
  await writeJson(path, task);
}

const lockPath = "benchmarks/tasks/corpus-v2.lock.json";
const lock = await readJson(lockPath);
if (lock.corpusId !== "agentix-commerce-maintenance-v2") {
  throw new Error(`Refusing to refresh unexpected corpus ${lock.corpusId}.`);
}
for (const file of lock.files) {
  file.sha256 = await digest(file.path);
}
await writeJson(lockPath, lock);

process.stdout.write(`${JSON.stringify({
  corpusId: lock.corpusId,
  baseSha256,
  corpusLockSha256: await digest(lockPath),
  fixtureCount: fixturePaths.length,
  taskCount: taskPaths.length,
})}\n`);
