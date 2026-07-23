import type {
  FixtureManifest,
  HiddenEvaluatorManifest,
  Implementation,
  TaskSpecification,
} from "./schemas.js";

export interface EvaluationStep {
  readonly id: string;
  readonly check:
    | "acceptance"
    | "hidden-regression"
    | "typecheck"
    | "architecture"
    | "prohibited-shortcuts"
    | "task-specific";
  readonly visibility: "agent-visible" | "evaluator-only";
  readonly applicability: "required" | "not_applicable";
  readonly command?: readonly string[];
  readonly definition?: HiddenEvaluatorManifest["checks"][number];
  readonly shortcutPolicy?: HiddenEvaluatorManifest["shortcutPolicy"];
}

export interface EvaluationPlan {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly implementation: Implementation;
  readonly maximumSeconds: number;
  readonly networkPolicy: "disabled";
  readonly steps: readonly EvaluationStep[];
}

export const createEvaluationPlan = (
  task: TaskSpecification,
  fixture: FixtureManifest,
  hidden: HiddenEvaluatorManifest,
): EvaluationPlan => {
  if (
    task.id !== fixture.taskId ||
    task.id !== hidden.taskId ||
    task.version !== fixture.taskVersion ||
    task.version !== hidden.taskVersion
  ) {
    throw new TypeError("Cannot plan evaluation for mismatched task artifacts.");
  }

  const steps: EvaluationStep[] = [];
  steps.push({
    id: "public-acceptance",
    check: "acceptance",
    visibility: "agent-visible",
    applicability: "required",
    ...(task.evaluator.kind === "workspace"
      ? { command: task.evaluator.commandByImplementation[fixture.implementation] }
      : {}),
  });
  for (const check of hidden.checks) {
    if (check.implementations.includes(fixture.implementation)) {
      steps.push({
        id: check.id,
        check: check.kind === "regression-command"
          ? "hidden-regression"
          : "task-specific",
        visibility: "evaluator-only",
        applicability: "required",
        definition: check,
        ...(check.kind === "regression-command"
          ? { command: check.commandByImplementation[fixture.implementation] }
          : {}),
      });
    }
  }
  steps.push({
    id: "typecheck",
    check: "typecheck",
    visibility: "evaluator-only",
    applicability: "required",
    command: fixture.evaluationCommands.typecheck,
  });
  steps.push({
    id: "architecture",
    check: "architecture",
    visibility: "evaluator-only",
    applicability: fixture.evaluationCommands.architecture === null
      ? "not_applicable"
      : "required",
    ...(fixture.evaluationCommands.architecture === null
      ? {}
      : { command: fixture.evaluationCommands.architecture }),
  });
  steps.push({
    id: "prohibited-shortcuts",
    check: "prohibited-shortcuts",
    visibility: "evaluator-only",
    applicability: "required",
    shortcutPolicy: hidden.shortcutPolicy,
  });

  return {
    taskId: task.id,
    taskVersion: task.version,
    implementation: fixture.implementation,
    maximumSeconds: task.maximumSeconds,
    networkPolicy: task.networkPolicy,
    steps,
  };
};
