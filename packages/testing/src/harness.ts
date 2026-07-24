import type {
  Application,
  CommandDescriptor,
  DeclaredError,
  DispatchResult,
  Infer,
  Principal,
  QueryDescriptor,
} from "@agentixdev/core";

export type OperationHarnessResult<
  Operation extends CommandDescriptor | QueryDescriptor,
> = DispatchResult<
  Infer<Operation["output"]>,
  DeclaredError<Operation["errors"]>
>;

export interface OperationHarnessOptions<
  Operation extends CommandDescriptor | QueryDescriptor,
> {
  readonly application: Application;
  readonly operation: Operation;
  readonly input: Infer<Operation["input"]>;
  /** Defaults to a deterministic principal granted the operation permissions. */
  readonly principal?: Principal;
  /** Defaults to true so effect and event assertions have evidence. */
  readonly trace?: boolean;
}

const testPrincipal = (
  operation: CommandDescriptor | QueryDescriptor,
): Principal => ({
  id: "agentix-test-principal",
  permissions: [...operation.permissions],
});

const dispatchForTest = async <
  Operation extends CommandDescriptor | QueryDescriptor,
>(
  options: OperationHarnessOptions<Operation>,
): Promise<OperationHarnessResult<Operation>> =>
  options.application.dispatch(options.operation, {
    input: options.input,
    principal: options.principal ?? testPrincipal(options.operation),
    trace: options.trace ?? true,
  });

/** Dispatches one command through the same validation and authorization path as production. */
export const testCommand = async <Operation extends CommandDescriptor>(
  options: OperationHarnessOptions<Operation>,
): Promise<OperationHarnessResult<Operation>> => {
  if (options.operation.kind !== "command") {
    throw new TypeError(`Operation ${options.operation.id} is not a command.`);
  }
  return dispatchForTest(options);
};

/** Dispatches one query through the same validation and authorization path as production. */
export const testQuery = async <Operation extends QueryDescriptor>(
  options: OperationHarnessOptions<Operation>,
): Promise<OperationHarnessResult<Operation>> => {
  if (options.operation.kind !== "query") {
    throw new TypeError(`Operation ${options.operation.id} is not a query.`);
  }
  return dispatchForTest(options);
};
