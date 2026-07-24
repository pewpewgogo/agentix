import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  assertFileDigest,
  readVerifiedGitBlobs,
  resolveInside,
} from "./integrity.js";
import { loadBaseInventory } from "./load.js";
import type { FixtureManifest, Implementation } from "./schemas.js";

const countOccurrences = (content: string, fragment: string): number => {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = content.indexOf(fragment, offset);
    if (next === -1) return count;
    count += 1;
    offset = next + fragment.length;
  }
};

const assertSafeTarget = (
  fixture: FixtureManifest,
  target: string,
): void => {
  const forbidden = fixture.agentWorkspace.excludedPrefixes.find(
    (prefix) => target === prefix || target.startsWith(`${prefix}/`),
  );
  if (forbidden !== undefined) {
    throw new Error(`Fixture attempts to copy excluded content at ${target}.`);
  }
};

export interface MaterializationResult {
  readonly implementation: Implementation;
  readonly files: readonly string[];
}

export const materializeFixture = async (
  repositoryRoot: string,
  destination: string,
  fixture: FixtureManifest,
): Promise<MaterializationResult> => {
  await mkdir(destination, { recursive: true });
  const existing = await readdir(destination);
  if (existing.length > 0) {
    throw new Error(`Fixture destination must be empty: ${destination}`);
  }

  const inventory = await loadBaseInventory(repositoryRoot, fixture);
  const selected = inventory.entries.filter(
    (entry) =>
      entry.audiences.includes("shared") ||
      entry.audiences.includes(fixture.implementation),
  );
  const copied: string[] = [];
  const targets = new Set<string>();

  for (const entry of selected) {
    assertSafeTarget(fixture, entry.target);
    if (targets.has(entry.target)) {
      throw new Error(`Fixture inventory has duplicate target ${entry.target}.`);
    }
    targets.add(entry.target);
  }
  const sourceBlobs = await readVerifiedGitBlobs(
    repositoryRoot,
    inventory.sourceRevision.commit,
    selected.map((entry) => ({
      repositoryPath: entry.source,
      expectedSha256: entry.sha256,
    })),
  );

  for (const entry of selected) {
    const source = sourceBlobs.get(entry.source);
    if (source === undefined) {
      throw new Error(`Frozen source read omitted ${entry.source}.`);
    }
    const target = resolveInside(destination, entry.target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
    await chmod(target, entry.executable ? 0o755 : 0o644);
    copied.push(entry.target);
  }

  for (const file of fixture.overlay.files) {
    assertSafeTarget(fixture, file.target);
    const source = resolveInside(repositoryRoot, file.source);
    await assertFileDigest(source, file.sha256);
    const target = resolveInside(destination, file.target);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    if (file.executable) await chmod(target, 0o755);
    if (!targets.has(file.target)) copied.push(file.target);
    targets.add(file.target);
  }

  for (const edit of fixture.overlay.edits) {
    assertSafeTarget(fixture, edit.path);
    const target = resolveInside(destination, edit.path);
    const content = await readFile(target, "utf8");
    const occurrences = countOccurrences(content, edit.find);
    if (occurrences !== edit.expectedOccurrences) {
      throw new Error(
        `${edit.path} overlay expected ${edit.expectedOccurrences} occurrence(s), received ${occurrences}.`,
      );
    }
    await writeFile(target, content.split(edit.find).join(edit.replace), "utf8");
  }

  const hiddenPath = resolve(destination, "benchmarks/evaluator/hidden");
  if (copied.some((path) => resolve(destination, path).startsWith(hiddenPath))) {
    throw new Error("Hidden evaluator content was copied into an agent workspace.");
  }
  return { implementation: fixture.implementation, files: copied.sort() };
};
