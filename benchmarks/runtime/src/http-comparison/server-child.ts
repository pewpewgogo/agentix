/**
 * Isolated-mode server child: runs exactly ONE HTTP comparison target in this
 * process, prints a single ready line on stdout, then serves until the parent
 * sends SIGTERM/SIGINT (or stdin closes). The measuring client stays in the
 * parent process, so requests cross real loopback sockets between processes.
 */
import { startTarget } from "./targets/registry.js";
import {
  HTTP_CONDITIONS,
  HTTP_STACKS,
  type HttpCondition,
  type HttpStack,
} from "./types.js";

export interface HttpComparisonServerReady {
  readonly schemaVersion: 1;
  readonly kind: "http-comparison-server-ready";
  readonly stack: HttpStack;
  readonly condition: HttpCondition;
  readonly origin: string;
}

const argumentValue = (name: string): string | undefined => {
  const match = process.argv.slice(2).find((value) =>
    value.startsWith(`${name}=`)
  );
  return match?.slice(name.length + 1);
};

const stackArgument = argumentValue("--stack");
const conditionArgument = argumentValue("--condition") ?? "default";

if (stackArgument !== undefined) {
  if (!(HTTP_STACKS as readonly string[]).includes(stackArgument)) {
    throw new TypeError(`Unknown HTTP comparison stack: ${stackArgument}`);
  }
  if (!(HTTP_CONDITIONS as readonly string[]).includes(conditionArgument)) {
    throw new TypeError(`Unknown HTTP comparison condition: ${conditionArgument}`);
  }
  const stack = stackArgument as HttpStack;
  const condition = conditionArgument as HttpCondition;
  const started = await startTarget(stack, condition);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void started.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // Exit if the parent disappears (its pipe to us closes).
  process.stdin.resume();
  process.stdin.on("end", shutdown);
  process.stdin.on("error", shutdown);

  const ready: HttpComparisonServerReady = {
    schemaVersion: 1,
    kind: "http-comparison-server-ready",
    stack,
    condition,
    origin: started.origin,
  };
  process.stdout.write(`${JSON.stringify(ready)}\n`);
}
