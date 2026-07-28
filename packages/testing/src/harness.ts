import type {
  AnyBoundOperation,
  BoundOperation,
  DeclaredError,
  DispatchOptions,
  DispatchResult,
  Infer,
  Principal,
} from "@agentixdev/core";

/**
 * Structural application surface used by the harnesses: anything returned by
 * `createApplication` satisfies it via the descriptor dispatch overload.
 */
export interface HarnessApplication {
  dispatch<Operation extends AnyBoundOperation>(
    operation: Operation,
    options: DispatchOptions<Infer<Operation["input"]>>,
  ): Promise<
    DispatchResult<Infer<Operation["output"]>, DeclaredError<Operation["errors"]>>
  >;
}

export type OperationHarnessResult<Operation extends AnyBoundOperation> =
  DispatchResult<Infer<Operation["output"]>, DeclaredError<Operation["errors"]>>;

export interface OperationHarnessOptions<Operation extends AnyBoundOperation> {
  readonly application: HarnessApplication;
  readonly operation: Operation;
  readonly input: Infer<Operation["input"]>;
  /** Defaults to a deterministic principal granted the operation permissions. */
  readonly principal?: Principal;
  /** Defaults to true so effect and event assertions have evidence. */
  readonly trace?: boolean;
}

const testPrincipal = (operation: AnyBoundOperation): Principal => ({
  id: "agentix-test-principal",
  permissions: [...operation.permissions],
});

const dispatchForTest = async <Operation extends AnyBoundOperation>(
  options: OperationHarnessOptions<Operation>,
): Promise<OperationHarnessResult<Operation>> =>
  options.application.dispatch(options.operation, {
    input: options.input,
    principal: options.principal ?? testPrincipal(options.operation),
    trace: options.trace ?? true,
  });

/** Dispatches one command through the same validation and authorization path as production. */
export const testCommand = async <Operation extends BoundOperation<string, "command">>(
  options: OperationHarnessOptions<Operation>,
): Promise<OperationHarnessResult<Operation>> => {
  if ((options.operation as AnyBoundOperation).kind !== "command") {
    throw new TypeError(`Operation ${options.operation.id} is not a command.`);
  }
  return dispatchForTest(options);
};

/** Dispatches one query through the same validation and authorization path as production. */
export const testQuery = async <Operation extends BoundOperation<string, "query">>(
  options: OperationHarnessOptions<Operation>,
): Promise<OperationHarnessResult<Operation>> => {
  if ((options.operation as AnyBoundOperation).kind !== "query") {
    throw new TypeError(`Operation ${options.operation.id} is not a query.`);
  }
  return dispatchForTest(options);
};
