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

export const repositoryPath = (rootDir: string, path: string): string => {
  const absolute = isAbsolute(path) ? path : resolve(rootDir, path);
  return toPosixPath(relative(resolve(rootDir), absolute));
};

/**
 * Feature segment for a repository path. Single-file features
 * (`src/features/notes.ts`, plus `notes.test.ts` beside it) and directory
 * features (`src/features/notes/...`) both map to segment `notes`.
 */
export const featureSegmentOf = (path: string): string | undefined => {
  const match = /(?:^|\/)src\/features\/([^/]+)(\/|$)/u.exec(path);
  if (match === null) return undefined;
  const part = match[1] as string;
  if (match[2] === "/") return part;
  const withoutTestSuffix = part.replace(
    /\.(?:agent-test|test|spec)\.[cm]?tsx?$/u,
    "",
  );
  if (withoutTestSuffix !== part) return withoutTestSuffix;
  return part.replace(/\.[cm]?tsx?$/u, "");
};

const walk = (directory: string, output: string[]): void => {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
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
      .sort((a, b) => repositoryPath(root, a).localeCompare(repositoryPath(root, b)));
  }

  const files: string[] = [];
  walk(root, files);
  return files
    .filter((file) => !isTestFixture(root, file))
    .sort((a, b) => repositoryPath(root, a).localeCompare(repositoryPath(root, b)));
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
    (a, b) => repositoryPath(root, a).localeCompare(repositoryPath(root, b)),
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
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, order(nested)]),
      );
    }
    return item;
  };
  return `${JSON.stringify(order(value), undefined, options.compact ? undefined : 2)}\n`;
};
