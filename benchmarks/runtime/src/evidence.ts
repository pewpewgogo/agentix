import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalValue(value));

export const hashJson = (value: unknown): string => sha256(canonicalJson(value));

export interface FileManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface FileManifest {
  readonly entries: readonly FileManifestEntry[];
  readonly sha256: string;
}

export const fileManifest = async (directory: string): Promise<FileManifest> => {
  const entries: FileManifestEntry[] = [];
  const visit = async (current: string): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const absolute = join(current, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`Evidence manifest refuses symbolic link ${absolute}.`);
      }
      if (child.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!child.isFile()) {
        throw new Error(`Evidence manifest refuses unsupported entry ${absolute}.`);
      }
      const content = await readFile(absolute);
      entries.push({
        path: relative(directory, absolute).split(sep).join("/"),
        sha256: sha256(content),
        bytes: content.byteLength,
      });
    }
  };
  await visit(directory);
  entries.sort((left, right) => compareText(left.path, right.path));
  const frozen = Object.freeze(entries.map((entry) => Object.freeze(entry)));
  return { entries: frozen, sha256: hashJson(frozen) };
};

export const assertSha256 = (name: string, value: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest.`);
  }
};
