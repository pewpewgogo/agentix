import { startTarget } from "./targets/registry.js";
import { HTTP_STACKS, type HttpStack } from "./types.js";

export interface HttpComparisonChildProbe {
  readonly schemaVersion: 1;
  readonly kind: "http-comparison-child-probe";
  readonly stack: HttpStack;
  readonly coldReadyNanoseconds: number;
  readonly readyRssBytes: number;
  readonly processMaxRssBytes: number | null;
  readonly processMaxRssUnavailableReason: string | null;
}

const normalizeMaxRss = (): {
  readonly bytes: number | null;
  readonly reason: string | null;
} => {
  const maxRssKiB = typeof process.resourceUsage === "function"
    ? process.resourceUsage().maxRSS
    : undefined;
  if (typeof maxRssKiB !== "number" || !Number.isSafeInteger(maxRssKiB) ||
      maxRssKiB <= 0) {
    return {
      bytes: null,
      reason: "process.resourceUsage().maxRSS was unavailable or non-positive.",
    };
  }
  const bytes = maxRssKiB * 1_024;
  return Number.isSafeInteger(bytes)
    ? { bytes, reason: null }
    : {
        bytes: null,
        reason: "process.resourceUsage().maxRSS could not be represented safely in bytes.",
      };
};

/**
 * Fresh-process probe: cold-ready covers dynamic module import plus server
 * start of exactly one stack. Both conditions serve identical startup work,
 * so probes always start the "default" condition.
 */
export const runHttpComparisonChildProbe = async (
  stack: HttpStack,
): Promise<HttpComparisonChildProbe> => {
  const collect = (globalThis as { readonly gc?: () => void }).gc;
  collect?.();

  const startedAt = process.hrtime.bigint();
  const started = await startTarget(stack, "default");
  const coldReadyNanoseconds = Number(process.hrtime.bigint() - startedAt);
  try {
    collect?.();
    const readyRssBytes = process.memoryUsage().rss;
    const maxRss = normalizeMaxRss();
    if (!Number.isSafeInteger(coldReadyNanoseconds) || coldReadyNanoseconds < 0 ||
        !Number.isSafeInteger(readyRssBytes) || readyRssBytes <= 0) {
      throw new RangeError("HTTP comparison child produced an invalid measurement.");
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "http-comparison-child-probe" as const,
      stack,
      coldReadyNanoseconds,
      readyRssBytes,
      processMaxRssBytes: maxRss.bytes,
      processMaxRssUnavailableReason: maxRss.reason,
    });
  } finally {
    await started.close();
  }
};

const argument = process.argv.slice(2).find((value) => value.startsWith("--stack="));
if (argument !== undefined) {
  const stack = argument.slice("--stack=".length);
  if (!(HTTP_STACKS as readonly string[]).includes(stack)) {
    throw new TypeError(`Unknown HTTP comparison stack: ${stack}`);
  }
  const result = await runHttpComparisonChildProbe(stack as HttpStack);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
