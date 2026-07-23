import { type HttpTarget, HTTP_STACKS, type HttpStack } from "./types.js";

interface TargetModule {
  readonly target?: unknown;
  readonly agentixTarget?: unknown;
  readonly expressTarget?: unknown;
  readonly nestjsTarget?: unknown;
}

export interface HttpComparisonChildProbe {
  readonly schemaVersion: 1;
  readonly kind: "http-comparison-child-probe";
  readonly stack: HttpStack;
  readonly coldReadyNanoseconds: number;
  readonly readyRssBytes: number;
  readonly processMaxRssBytes: number | null;
  readonly processMaxRssUnavailableReason: string | null;
}

const targetModuleFor = (stack: HttpStack): URL => {
  switch (stack) {
    case "agentix-node":
      return new URL("./targets/agentix.js", import.meta.url);
    case "express":
      return new URL("./targets/express.js", import.meta.url);
    case "nestjs-express":
      return new URL("./targets/nestjs.js", import.meta.url);
  }
};

const targetExportFor = (stack: HttpStack, module: TargetModule): unknown => {
  switch (stack) {
    case "agentix-node":
      return module.agentixTarget ?? module.target;
    case "express":
      return module.expressTarget ?? module.target;
    case "nestjs-express":
      return module.nestjsTarget ?? module.target;
  }
};

const isHttpTarget = (value: unknown, stack: HttpStack): value is HttpTarget =>
  typeof value === "object" && value !== null &&
  Reflect.get(value, "stack") === stack &&
  typeof Reflect.get(value, "start") === "function";

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

export const runHttpComparisonChildProbe = async (
  stack: HttpStack,
): Promise<HttpComparisonChildProbe> => {
  const collect = (globalThis as { readonly gc?: () => void }).gc;
  collect?.();

  const startedAt = process.hrtime.bigint();
  const module = await import(targetModuleFor(stack).href) as TargetModule;
  const candidate = targetExportFor(stack, module);
  if (!isHttpTarget(candidate, stack)) {
    throw new TypeError(`HTTP comparison target module for ${stack} is invalid.`);
  }

  const started = await candidate.start();
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
