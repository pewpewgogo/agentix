import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

export const resolveInside = (
  repositoryRoot: string,
  repositoryPath: string,
): string => {
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, repositoryPath);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !fromRoot.startsWith(sep))
  ) {
    return candidate;
  }
  throw new TypeError(`Path escapes repository root: ${repositoryPath}`);
};

export const digestFile = async (absolutePath: string): Promise<string> =>
  sha256(await readFile(absolutePath));

export const assertFileDigest = async (
  absolutePath: string,
  expected: string,
): Promise<void> => {
  const actual = await digestFile(absolutePath);
  if (actual !== expected) {
    throw new Error(
      `Integrity mismatch for ${absolutePath}: expected ${expected}, received ${actual}.`,
    );
  }
};
