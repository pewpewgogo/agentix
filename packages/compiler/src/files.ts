import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ManifestEntry, SourceManifest } from "./types.js";

const ignoredDirectories = new Set([
  ".agentix",
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const sourceExtension = /\.(?:[cm]?ts|tsx)$/u;
const declarationExtension = /\.d\.[cm]?ts$/u;

export const toPosixPath = (path: string): string => path.split(sep).join("/");

/**
 * Deterministic code-unit comparator. Generated artifacts must be
 * byte-identical across machines, so ordering never uses localeCompare
 * (whose result depends on the process locale and ICU data).
 */
export const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const repositoryPath = (rootDir: string, path: string): string => {
  const absolute = isAbsolute(path) ? path : resolve(rootDir, path);
  return toPosixPath(relative(resolve(rootDir), absolute));
};

/**
 * Feature segment for a repository path. Single-file features claim the
 * name up to the FIRST dot, so the feature file, dotted helpers, and every
 * colocated test suffix map to one segment: `src/features/notes.ts`,
 * `notes.helpers.ts`, `notes.test.ts`, and `notes.integration.test.ts` all
 * belong to segment `notes`, as does the directory form
 * (`src/features/notes/...`).
 */
export const featureSegmentOf = (path: string): string | undefined => {
  const match = /(?:^|\/)src\/features\/([^/]+)(\/|$)/u.exec(path);
  if (match === null) return undefined;
  const part = match[1] as string;
  if (match[2] === "/") return part;
  const dot = part.indexOf(".");
  const segment = dot === -1 ? part : part.slice(0, dot);
  return segment === "" ? undefined : segment;
};

const walk = (directory: string, output: string[]): void => {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    compareStrings(a.name, b.name),
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        walk(resolve(directory, entry.name), output);
      }
      continue;
    }
    if (
      entry.isFile() &&
      sourceExtension.test(entry.name) &&
      !declarationExtension.test(entry.name)
    ) {
      output.push(resolve(directory, entry.name));
    }
  }
};

const isTestFixture = (rootDir: string, file: string): boolean => {
  const path = repositoryPath(rootDir, file);
  return /(?:^|\/)(?:test|tests)\/fixtures\//u.test(path);
};

export const discoverSourceFiles = (
  rootDir: string,
  explicitFiles?: readonly string[],
): string[] => {
  const root = resolve(rootDir);
  if (explicitFiles !== undefined) {
    return [...new Set(explicitFiles.map((file) => resolve(root, file)))]
      .filter((file) => existsSync(file) && statSync(file).isFile())
      .sort((a, b) => compareStrings(repositoryPath(root, a), repositoryPath(root, b)));
  }

  const files: string[] = [];
  walk(root, files);
  return files
    .filter((file) => !isTestFixture(root, file))
    .sort((a, b) => compareStrings(repositoryPath(root, a), repositoryPath(root, b)));
};

const manifestCandidates = (rootDir: string, sourceFiles: readonly string[]): string[] => {
  const root = resolve(rootDir);
  const configFiles = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "vitest.config.ts",
  ]
    .map((file) => resolve(root, file))
    .filter((file) => existsSync(file) && statSync(file).isFile());
  return [...new Set([...sourceFiles.map((file) => resolve(file)), ...configFiles])].sort(
    (a, b) => compareStrings(repositoryPath(root, a), repositoryPath(root, b)),
  );
};

export const createSourceManifest = (
  rootDir: string,
  sourceFiles: readonly string[],
): SourceManifest => {
  const files: ManifestEntry[] = manifestCandidates(rootDir, sourceFiles).map((file) => ({
    file: repositoryPath(rootDir, file),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  }));
  const digest = createHash("sha256")
    .update(files.map(({ file, sha256 }) => `${file}\0${sha256}\n`).join(""))
    .digest("hex");
  return { algorithm: "sha256", digest, files };
};

/**
 * Line-preserving whitespace normalization for embedded source excerpts:
 * every line loses its leading indentation (column-0 normalized), trailing
 * per-line whitespace is dropped, and the result is trimmed. Keeps the
 * statement structure readable while removing the bytes that JSON escaping
 * makes expensive.
 */
export const dedentText = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/u, "").replace(/[ \t]+$/u, ""))
    .join("\n")
    .trim();

export interface StableJsonOptions {
  readonly compact?: boolean;
}

export const stableJson = (
  value: unknown,
  options: StableJsonOptions = {},
): string => {
  const order = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(order);
    }
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => compareStrings(left, right))
          .map(([key, nested]) => [key, order(nested)]),
      );
    }
    return item;
  };
  return `${JSON.stringify(order(value), undefined, options.compact ? undefined : 2)}\n`;
};
