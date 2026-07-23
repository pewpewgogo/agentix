import { createHash } from "node:crypto";

import type { InstructionHashes, InstructionSet } from "./types.js";

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const normalizeText = (value: string): string =>
  value.normalize("NFC").replace(/\r\n?/gu, "\n");

const canonicalValue = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string" ? normalizeText(value) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
};

export const canonicalJson = (value: unknown): string => {
  const serialized = JSON.stringify(canonicalValue(value));
  if (serialized === undefined) {
    throw new TypeError("Canonical JSON requires a serializable value.");
  }
  return serialized;
};

const hashText = (value: string): string => sha256(normalizeText(value));

export const hashInstructionSet = (
  instructions: InstructionSet,
): InstructionHashes => {
  const componentHashes = {
    system: hashText(instructions.system),
    developer: hashText(instructions.developer),
    user: hashText(instructions.user),
    tools: sha256(canonicalJson(instructions.tools)),
    permissions: sha256(canonicalJson(instructions.permissions)),
    limits: sha256(canonicalJson(instructions.limits)),
  };
  return {
    algorithm: "sha256",
    normalization: "unicode-nfc+lf",
    ...componentHashes,
    bundle: sha256(canonicalJson(componentHashes)),
  };
};
