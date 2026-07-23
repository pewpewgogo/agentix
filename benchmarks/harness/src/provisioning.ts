import { canonicalJson, sha256 } from "./hash.js";
import type { BenchmarkProvisioningPlan } from "./types.js";
import { normalizeWorkspacePath } from "./workspace.js";

export const DEFAULT_PROVISIONING_MUTABLE_PREFIXES = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".agentix",
] as const;

const SAFE_MUTABLE_DIRECTORY_NAMES = new Set(
  DEFAULT_PROVISIONING_MUTABLE_PREFIXES,
);

const assertSafeMutablePrefix = (prefix: string): string => {
  const normalized = normalizeWorkspacePath(prefix);
  const finalSegment = normalized.split("/").at(-1);
  if (finalSegment === undefined || !SAFE_MUTABLE_DIRECTORY_NAMES.has(
    finalSegment as (typeof DEFAULT_PROVISIONING_MUTABLE_PREFIXES)[number],
  )) {
    throw new TypeError(
      `Provisioning mutable prefix is not a safe generated/dependency path: ${prefix}`,
    );
  }
  return normalized;
};

export interface ResolvedProvisioningConfiguration {
  readonly command: readonly string[] | null;
  readonly cachePolicy: string;
  readonly mutablePathPrefixes: readonly string[];
  readonly hash: string;
}

export const resolveProvisioningConfiguration = (input: {
  readonly plan?: Pick<
    BenchmarkProvisioningPlan,
    "command" | "cachePolicy" | "mutablePathPrefixes"
  >;
  readonly environmentCachePolicy: string;
}): ResolvedProvisioningConfiguration => {
  const mutablePathPrefixes = [...new Set([
    ...DEFAULT_PROVISIONING_MUTABLE_PREFIXES,
    ...(input.plan?.mutablePathPrefixes ?? []),
  ].map(assertSafeMutablePrefix))].sort();
  const value = {
    command: input.plan?.command ?? null,
    cachePolicy: input.plan?.cachePolicy ?? input.environmentCachePolicy,
    mutablePathPrefixes,
  };
  return { ...value, hash: sha256(canonicalJson(value)) };
};
