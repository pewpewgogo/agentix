import type {
  BenchmarkArm,
  EvaluationSummary,
  ExecutionMode,
  LifecycleCheck,
} from "./types.js";

export const REQUIRED_EVALUATOR_CHECKS = [
  "acceptance",
  "hidden-regression",
  "typecheck",
  "architecture",
  "prohibited-shortcuts",
  "task-specific",
] as const;

export const validateLifecycleChecks = (
  checks: readonly LifecycleCheck[],
  label: string,
): void => {
  for (const check of checks) {
    if (
      check.name.trim().length === 0 ||
      !["passed", "failed", "not_applicable"].includes(check.status) ||
      !Number.isSafeInteger(check.durationMs) ||
      check.durationMs < 0 ||
      (check.details !== null && check.details.trim().length === 0)
    ) {
      throw new TypeError(`Malformed ${label} lifecycle check.`);
    }
  }
};

const expectedPass = (check: LifecycleCheck, arm: BenchmarkArm): boolean =>
  check.status === "passed" ||
  (check.name === "architecture" &&
    arm === "plain" &&
    check.status === "not_applicable");

export const deriveEvaluationSummary = (input: {
  readonly supplied: EvaluationSummary;
  readonly mode: ExecutionMode;
  readonly arm: BenchmarkArm;
}): EvaluationSummary => {
  validateLifecycleChecks(input.supplied.checks, "evaluator");
  const reasons: string[] = [];
  let checksPass: boolean;
  if (input.mode === "confirmatory") {
    checksPass = true;
    for (const name of REQUIRED_EVALUATOR_CHECKS) {
      const named = input.supplied.checks.filter((check) => check.name === name);
      if (named.length !== 1) {
        checksPass = false;
        reasons.push(`required evaluator check ${name} appears ${named.length} times`);
      } else if (!expectedPass(named[0] as LifecycleCheck, input.arm)) {
        checksPass = false;
      }
    }
    if (input.supplied.checks.some(({ status }) => status === "failed")) {
      checksPass = false;
    }
  } else {
    checksPass =
      input.supplied.checks.length > 0 &&
      input.supplied.checks.every(({ status }) => status !== "failed");
  }
  const invalidRunReason = [
    input.supplied.invalidRunReason,
    ...reasons,
  ]
    .filter((reason): reason is string => reason !== null && reason.length > 0)
    .join("; ") || null;
  return {
    checks: [...input.supplied.checks],
    success: checksPass && invalidRunReason === null,
    failureCategory: input.supplied.failureCategory,
    invalidRunReason,
  };
};
