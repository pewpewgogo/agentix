import { resolve } from "node:path";

import { loadBaseInventory, loadCorpus } from "./load.js";

const repositoryRoot = resolve(process.argv[2] ?? ".");
const corpus = await loadCorpus(repositoryRoot);
const firstFixture = corpus.tasks[0]?.arms.framework.fixture;
if (firstFixture === undefined) {
  throw new Error("Frozen corpus has no tasks.");
}
const inventory = await loadBaseInventory(repositoryRoot, firstFixture);

process.stdout.write(`${JSON.stringify({
  corpusId: corpus.lock.corpusId,
  corpusVersion: corpus.lock.corpusVersion,
  taskCount: corpus.tasks.length,
  fixtureArmCount: corpus.tasks.length * 2,
  inventoryFileCount: inventory.entries.length,
  status: "verified",
})}\n`);
