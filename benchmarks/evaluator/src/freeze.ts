import { resolve } from "node:path";

import { loadBaseInventory, loadCorpus } from "./load.js";
import { CORPUS_VERSIONS, type CorpusVersion } from "./schemas.js";

const parseArguments = (): { readonly root: string; readonly version: CorpusVersion } => {
  const positional: string[] = [];
  let version: CorpusVersion = "v1";
  const values = process.argv.slice(2);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--corpus") {
      const requested = values[index + 1];
      if (!CORPUS_VERSIONS.includes(requested as CorpusVersion)) {
        throw new Error(
          `--corpus requires one of: ${CORPUS_VERSIONS.join(", ")}; received ${requested ?? "nothing"}.`,
        );
      }
      version = requested as CorpusVersion;
      index += 1;
      continue;
    }
    positional.push(value ?? "");
  }
  return { root: resolve(positional[0] ?? "."), version };
};

const { root: repositoryRoot, version } = parseArguments();
const corpus = await loadCorpus(repositoryRoot, version);
const firstFixture = corpus.tasks[0]?.arms.framework.fixture;
if (firstFixture === undefined) {
  throw new Error("Frozen corpus has no tasks.");
}
const inventory = await loadBaseInventory(repositoryRoot, firstFixture);

process.stdout.write(`${JSON.stringify({
  corpusId: corpus.lock.corpusId,
  corpusVersion: corpus.lock.corpusVersion,
  sourceRevision: inventory.sourceRevision.commit,
  taskCount: corpus.tasks.length,
  fixtureArmCount: corpus.tasks.length * 2,
  inventoryFileCount: inventory.entries.length,
  status: "verified",
})}\n`);
