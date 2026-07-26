import type {
  HttpCondition,
  HttpStack,
  StartedHttpTarget,
} from "../types.js";

/**
 * Dynamic-import registry. Import stays lazy and per-stack so the cold-ready
 * probe child measures exactly one framework's module graph, and so isolated
 * server children never load the other frameworks.
 */
const targetModuleFor = (stack: HttpStack): URL => {
  switch (stack) {
    case "agentix-node":
      return new URL("./agentix.js", import.meta.url);
    case "express":
      return new URL("./express.js", import.meta.url);
    case "nestjs-express":
      return new URL("./nestjs.js", import.meta.url);
  }
};

interface TargetModule {
  readonly stack?: unknown;
  readonly start?: unknown;
}

export const startTarget = async (
  stack: HttpStack,
  condition: HttpCondition,
): Promise<StartedHttpTarget> => {
  const module = await import(targetModuleFor(stack).href) as TargetModule;
  if (module.stack !== stack || typeof module.start !== "function") {
    throw new TypeError(`HTTP comparison target module for ${stack} is invalid.`);
  }
  const started = await (module.start as (
    condition: HttpCondition,
  ) => Promise<unknown>)(condition);
  if (typeof started !== "object" || started === null ||
      Reflect.get(started, "stack") !== stack ||
      typeof Reflect.get(started, "origin") !== "string" ||
      typeof Reflect.get(started, "close") !== "function") {
    throw new TypeError(`HTTP comparison target for ${stack} started invalidly.`);
  }
  return started as StartedHttpTarget;
};
