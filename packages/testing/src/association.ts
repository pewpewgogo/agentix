export interface AssociableOperation {
  readonly id: string;
  readonly kind: "command" | "query";
}

export interface OperationTestAssociation<
  Operation extends AssociableOperation = AssociableOperation,
> {
  readonly kind: "operation-test";
  readonly id: string;
  readonly operation: Operation;
}

export interface DefineOperationTestOptions<
  Operation extends AssociableOperation,
> {
  readonly id: string;
  readonly operation: Operation;
}

/**
 * A normal value declaration that gives the compiler a typed, source-level
 * association between an operation and its tests.
 */
export const defineOperationTest = <Operation extends AssociableOperation>(
  options: DefineOperationTestOptions<Operation>,
): OperationTestAssociation<Operation> => {
  if (options.id.length === 0) {
    throw new TypeError("An operation test association requires an ID.");
  }
  return Object.freeze({
    kind: "operation-test",
    id: options.id,
    operation: options.operation,
  });
};

export const associateOperationTest = <Operation extends AssociableOperation>(
  operation: Operation,
  id = `${operation.id}.test`,
): OperationTestAssociation<Operation> =>
  defineOperationTest({ id, operation });
