import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(process.argv[2] ?? process.cwd());
const fromRoot = (path) => resolve(repositoryRoot, path);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = async (path) => sha256(await readFile(fromRoot(path)));
const readJson = async (path) => JSON.parse(await readFile(fromRoot(path), "utf8"));
const writeJson = async (path, value) => {
  await writeFile(fromRoot(path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const basePath = "benchmarks/fixtures/v1/base.repository.json";
const base = await readJson(basePath);
if (base.id !== "agentix-commerce-app-base") {
  throw new Error(`Refusing to refresh unexpected base inventory ${base.id}.`);
}
for (const entry of base.entries) {
  entry.sha256 = await digest(entry.source);
}
await writeJson(basePath, base);
const baseSha256 = await digest(basePath);

const fixturePaths = [];
const fixtureRoot = "benchmarks/fixtures/v1";
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

const taskDirectory = "benchmarks/tasks/v1";
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

const lockPath = "benchmarks/tasks/corpus.lock.json";
const lock = await readJson(lockPath);
if (lock.corpusId !== "agentix-commerce-maintenance-v1") {
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
