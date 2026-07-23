export type ContractAdapter = object;

type OperationName<Adapter extends ContractAdapter> = {
  readonly [Name in keyof Adapter]: Adapter[Name] extends (
    input: never,
  ) => unknown
    ? Name
    : never;
}[keyof Adapter] & string;

type OperationAt<
  Adapter extends ContractAdapter,
  Name extends OperationName<Adapter>,
> = Extract<Adapter[Name], (input: never) => unknown>;

type ContractCaseFor<Adapter extends ContractAdapter> = {
  readonly [Name in OperationName<Adapter>]: {
    readonly id: string;
    readonly operation: Name;
    readonly input: Parameters<OperationAt<Adapter, Name>>[0];
    readonly assert: (
      output: Awaited<ReturnType<OperationAt<Adapter, Name>>>,
    ) => void | Promise<void>;
  };
}[OperationName<Adapter>];

export interface AdapterContract<Adapter extends ContractAdapter> {
  readonly id: string;
  readonly cases: readonly ContractCaseFor<Adapter>[];
}

export interface AdapterContractResult {
  readonly contractId: string;
  readonly passedCases: readonly string[];
}

export const defineAdapterContract = <Adapter extends ContractAdapter>(
  contract: AdapterContract<Adapter>,
): AdapterContract<Adapter> => {
  if (contract.id.length === 0) {
    throw new TypeError("An adapter contract requires an ID.");
  }
  const caseIds = new Set<string>();
  for (const contractCase of contract.cases) {
    if (contractCase.id.length === 0) {
      throw new TypeError("Every adapter contract case requires an ID.");
    }
    if (caseIds.has(contractCase.id)) {
      throw new TypeError(
        `Duplicate adapter contract case ID ${contractCase.id}.`,
      );
    }
    caseIds.add(contractCase.id);
  }

  return Object.freeze({
    ...contract,
    cases: Object.freeze([...contract.cases]),
  });
};

const runCase = async <Adapter extends ContractAdapter>(
  adapter: Adapter,
  contractCase: ContractCaseFor<Adapter>,
): Promise<void> => {
  const operation = adapter[contractCase.operation];
  if (operation === undefined) {
    throw new TypeError(
      `Adapter is missing operation ${String(contractCase.operation)}.`,
    );
  }
  const output = await (operation as (input: never) => unknown)(
    contractCase.input as never,
  );
  await contractCase.assert(
    output as Awaited<
      ReturnType<OperationAt<Adapter, typeof contractCase.operation>>
    >,
  );
};

/** Runs a reusable port contract against one explicit adapter instance. */
export const runAdapterContract = async <Adapter extends ContractAdapter>(
  contract: AdapterContract<Adapter>,
  adapter: Adapter,
): Promise<AdapterContractResult> => {
  const passedCases: string[] = [];
  for (const contractCase of contract.cases) {
    await runCase(adapter, contractCase);
    passedCases.push(contractCase.id);
  }
  return {
    contractId: contract.id,
    passedCases,
  };
};
