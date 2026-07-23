import type { Outcome } from "./outcome.js";
import type { Infer, Schema } from "./schema.js";

export type MaybePromise<T> = T | Promise<T>;

export type EffectKind = "read" | "write" | "time" | "random" | "external";

export type ErrorSchemaMap = Readonly<Record<string, Schema<unknown>>>;

export type DeclaredError<Errors extends ErrorSchemaMap> = {
  [Code in keyof Errors & string]: Readonly<{
    code: Code;
    details: Infer<Errors[Code]>;
  }>;
}[keyof Errors & string];

export const domainError = <
  const Code extends string,
  Details,
>(code: Code, details: Details): Readonly<{ code: Code; details: Details }> =>
  Object.freeze({ code, details });

export interface UnboundPortOperationDescriptor<
  Id extends string = string,
  Kind extends EffectKind = EffectKind,
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
> {
  readonly descriptorType: "port-operation";
  readonly id: Id;
  readonly kind: Kind;
  readonly input: Input;
  readonly output: Output;
  readonly errors: Errors;
}

export interface PortOperationDescriptor<
  Id extends string = string,
  Kind extends EffectKind = EffectKind,
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
  PortId extends string = string,
> extends UnboundPortOperationDescriptor<Id, Kind, Input, Output, Errors> {
  readonly portId: PortId;
  readonly operationKey: string;
}

export type AnyPortOperationDescriptor = PortOperationDescriptor<
  string,
  EffectKind,
  Schema<unknown>,
  Schema<unknown>,
  ErrorSchemaMap,
  string
>;

export const portOperation = <
  const Id extends string,
  const Kind extends EffectKind,
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  const Errors extends ErrorSchemaMap = Record<never, never>,
>(definition: {
  readonly id: Id;
  readonly kind: Kind;
  readonly input: Input;
  readonly output: Output;
  readonly errors?: Errors;
}): UnboundPortOperationDescriptor<Id, Kind, Input, Output, Errors> => {
  assertStableId(definition.id, "Port operation");
  return Object.freeze({
    descriptorType: "port-operation",
    id: definition.id,
    kind: definition.kind,
    input: definition.input,
    output: definition.output,
    errors: freezeRecord(definition.errors ?? {}) as Errors,
  });
};

type UnboundOperationMap = Readonly<
  Record<string, UnboundPortOperationDescriptor>
>;

type BoundOperationMap<
  PortId extends string,
  Operations extends UnboundOperationMap,
> = {
  readonly [Key in keyof Operations]: Operations[Key] extends UnboundPortOperationDescriptor<
    infer Id,
    infer Kind,
    infer Input,
    infer Output,
    infer Errors
  >
    ? PortOperationDescriptor<Id, Kind, Input, Output, Errors, PortId>
    : never;
};

export interface PortDescriptor<
  Id extends string = string,
  Operations extends Readonly<Record<string, AnyPortOperationDescriptor>> = Readonly<
    Record<string, AnyPortOperationDescriptor>
  >,
> {
  readonly descriptorType: "port";
  readonly id: Id;
  readonly operations: Operations;
}

export const definePort = <
  const Id extends string,
  const Operations extends UnboundOperationMap,
>(definition: {
  readonly id: Id;
  readonly operations: Operations;
}): PortDescriptor<Id, BoundOperationMap<Id, Operations>> => {
  assertStableId(definition.id, "Port");
  const seen = new Set<string>();
  const operations: Record<string, AnyPortOperationDescriptor> = {};
  for (const key of Object.keys(definition.operations).sort()) {
    const operation = definition.operations[key];
    if (operation === undefined) continue;
    if (seen.has(operation.id)) {
      throw new TypeError(`Duplicate port operation id ${JSON.stringify(operation.id)}`);
    }
    seen.add(operation.id);
    operations[key] = Object.freeze({
      ...operation,
      portId: definition.id,
      operationKey: key,
    }) as AnyPortOperationDescriptor;
  }
  return Object.freeze({
    descriptorType: "port",
    id: definition.id,
    operations: Object.freeze(operations) as BoundOperationMap<Id, Operations>,
  });
};

export type EffectHandler<Operation extends AnyPortOperationDescriptor> = (
  input: Infer<Operation["input"]>,
) => MaybePromise<
  Outcome<Infer<Operation["output"]>, DeclaredError<Operation["errors"]>>
>;

export type PortImplementation<Port extends PortDescriptor> = {
  readonly [Key in keyof Port["operations"]]: Port["operations"][Key] extends AnyPortOperationDescriptor
    ? EffectHandler<Port["operations"][Key]>
    : never;
};

export interface BoundPortAdapter<Port extends PortDescriptor = PortDescriptor> {
  readonly descriptorType: "port-adapter";
  readonly port: Port;
  readonly operations: PortImplementation<Port>;
}

export const bindPort = <Port extends PortDescriptor>(
  port: Port,
  implementation: PortImplementation<Port>,
): BoundPortAdapter<Port> =>
  Object.freeze({
    descriptorType: "port-adapter",
    port,
    operations: freezeRecord(implementation),
  });

export const defineAdapter = bindPort;

export interface EventDescriptor<
  Id extends string = string,
  Version extends number = number,
  Payload extends Schema<unknown> = Schema<unknown>,
> {
  readonly descriptorType: "event";
  readonly id: Id;
  readonly version: Version;
  readonly payload: Payload;
}

export const defineEvent = <
  const Id extends string,
  const Version extends number,
  Payload extends Schema<unknown>,
>(definition: {
  readonly id: Id;
  readonly version: Version;
  readonly payload: Payload;
}): EventDescriptor<Id, Version, Payload> => {
  assertStableId(definition.id, "Event");
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new TypeError("Event version must be a positive safe integer");
  }
  return Object.freeze({ descriptorType: "event", ...definition });
};

export interface FeatureContractDescriptor<
  Id extends string = string,
  Exports extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
> {
  readonly descriptorType: "feature-contract";
  readonly id: Id;
  readonly exports: Exports;
}

export const defineFeatureContract = <
  const Id extends string,
  const Exports extends Readonly<Record<string, unknown>> = Record<never, never>,
>(definition: {
  readonly id: Id;
  readonly exports?: Exports;
}): FeatureContractDescriptor<Id, Exports> => {
  assertStableId(definition.id, "Feature contract");
  return Object.freeze({
    descriptorType: "feature-contract",
    id: definition.id,
    exports: freezeRecord(definition.exports ?? {}) as Exports,
  });
};

export const defineContract = defineFeatureContract;

export type ContractReference = Readonly<{ id: string }>;

export interface InvariantDescriptor<
  Id extends string = string,
  Evidence extends Schema<unknown> = Schema<unknown>,
  Dependencies extends readonly ContractReference[] = readonly ContractReference[],
> {
  readonly descriptorType: "invariant";
  readonly id: Id;
  readonly dependsOn: Dependencies;
  readonly evidence: Evidence;
  check(evidence: Infer<Evidence>): boolean;
}

export const defineInvariant = <
  const Id extends string,
  Evidence extends Schema<unknown>,
  const Dependencies extends readonly ContractReference[],
>(definition: {
  readonly id: Id;
  readonly dependsOn: Dependencies;
  readonly evidence: Evidence;
  readonly check: (evidence: Infer<Evidence>) => boolean;
}): InvariantDescriptor<Id, Evidence, Dependencies> => {
  assertStableId(definition.id, "Invariant");
  return Object.freeze({
    descriptorType: "invariant",
    id: definition.id,
    dependsOn: Object.freeze([...definition.dependsOn]) as Dependencies,
    evidence: definition.evidence,
    check: definition.check,
  });
};

export type EffectMap = Readonly<Record<string, AnyPortOperationDescriptor>>;
export type EventMap = Readonly<Record<string, EventDescriptor>>;

export type EffectContext<Effects extends EffectMap> = {
  readonly [Name in keyof Effects]: Effects[Name] extends AnyPortOperationDescriptor
    ? EffectHandler<Effects[Name]>
    : never;
};

export type EventEmitter<Events extends EventMap> = {
  readonly [Name in keyof Events]: Events[Name] extends EventDescriptor<
    string,
    number,
    infer Payload
  >
    ? (payload: Infer<Payload>) => void
    : never;
};

export interface OperationExecutionContext<
  Input extends Schema<unknown>,
  Effects extends EffectMap,
  Emits extends EventMap,
> {
  readonly input: Infer<Input>;
  readonly effects: EffectContext<Effects>;
  readonly emit: EventEmitter<Emits>;
}

export interface OperationDescriptor<
  Id extends string = string,
  Kind extends "command" | "query" = "command" | "query",
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
  Effects extends EffectMap = EffectMap,
  Emits extends EventMap = EventMap,
> {
  readonly descriptorType: "operation";
  readonly kind: Kind;
  readonly id: Id;
  readonly input: Input;
  readonly output: Output;
  readonly errors: Errors;
  readonly permissions: readonly string[];
  readonly effects: Effects;
  readonly emits: Emits;
  readonly invariants: readonly InvariantDescriptor[];
  execute(
    context: OperationExecutionContext<Input, Effects, Emits>,
  ): MaybePromise<Outcome<Infer<Output>, DeclaredError<Errors>>>;
}

export type CommandDescriptor<
  Id extends string = string,
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
  Effects extends EffectMap = EffectMap,
  Emits extends EventMap = EventMap,
> = OperationDescriptor<Id, "command", Input, Output, Errors, Effects, Emits>;

export type QueryDescriptor<
  Id extends string = string,
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
  Effects extends EffectMap = EffectMap,
> = OperationDescriptor<Id, "query", Input, Output, Errors, Effects, Record<never, never>>;

export type AnyOperationDescriptor = OperationDescriptor<
  string,
  "command" | "query",
  Schema<unknown>,
  Schema<unknown>,
  ErrorSchemaMap,
  EffectMap,
  EventMap
>;

interface CommonOperationDefinition<
  Id extends string,
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  Errors extends ErrorSchemaMap,
  Effects extends EffectMap,
> {
  readonly id: Id;
  readonly input: Input;
  readonly output: Output;
  readonly errors: Errors;
  readonly permissions: readonly string[];
  readonly effects: Effects;
  readonly invariants?: readonly InvariantDescriptor[];
}

export const defineCommand = <
  const Id extends string,
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  const Errors extends ErrorSchemaMap,
  const Effects extends EffectMap,
  const Emits extends EventMap,
>(definition: CommonOperationDefinition<Id, Input, Output, Errors, Effects> & {
  readonly emits: Emits;
  readonly execute: (
    context: OperationExecutionContext<Input, Effects, Emits>,
  ) => MaybePromise<Outcome<Infer<Output>, DeclaredError<Errors>>>;
}): CommandDescriptor<Id, Input, Output, Errors, Effects, Emits> => {
  validateOperationDefinition(definition);
  assertUniqueDescriptorIds(definition.emits, `${definition.id} event`);
  return Object.freeze({
    descriptorType: "operation",
    kind: "command",
    ...definition,
    permissions: freezeStrings(definition.permissions),
    effects: freezeRecord(definition.effects),
    emits: freezeRecord(definition.emits),
    invariants: Object.freeze([...(definition.invariants ?? [])]),
  });
};

type WithoutWriteEffects<Effects extends EffectMap> = {
  readonly [Name in keyof Effects]: Effects[Name]["kind"] extends "write"
    ? never
    : Effects[Name];
};

export const defineQuery = <
  const Id extends string,
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  const Errors extends ErrorSchemaMap,
  const Effects extends EffectMap,
>(definition: CommonOperationDefinition<Id, Input, Output, Errors, Effects> & {
  readonly effects: Effects & WithoutWriteEffects<Effects>;
  readonly emits?: never;
  readonly execute: (
    context: OperationExecutionContext<Input, Effects, Record<never, never>>,
  ) => MaybePromise<Outcome<Infer<Output>, DeclaredError<Errors>>>;
}): QueryDescriptor<Id, Input, Output, Errors, Effects> => {
  validateOperationDefinition(definition);
  for (const operation of Object.values(definition.effects)) {
    if (operation.kind === "write") {
      throw new TypeError(`Query ${definition.id} cannot declare write effect ${operation.id}`);
    }
  }
  return Object.freeze({
    descriptorType: "operation",
    kind: "query",
    id: definition.id,
    input: definition.input,
    output: definition.output,
    errors: freezeRecord(definition.errors),
    permissions: freezeStrings(definition.permissions),
    effects: freezeRecord(definition.effects),
    emits: Object.freeze({}),
    invariants: Object.freeze([...(definition.invariants ?? [])]),
    execute: definition.execute,
  });
};

export const command = defineCommand;
export const query = defineQuery;
export const event = defineEvent;
export const invariant = defineInvariant;

export interface FeatureDescriptor<
  Id extends string = string,
  Contract extends FeatureContractDescriptor = FeatureContractDescriptor,
  Dependencies extends readonly ContractReference[] = readonly ContractReference[],
  Operations extends readonly AnyOperationDescriptor[] = readonly AnyOperationDescriptor[],
  Invariants extends readonly InvariantDescriptor[] = readonly InvariantDescriptor[],
> {
  readonly descriptorType: "feature";
  readonly id: Id;
  readonly contract: Contract;
  readonly dependencies: Dependencies;
  readonly operations: Operations;
  readonly invariants: Invariants;
  readonly events: readonly EventDescriptor[];
  readonly ports: readonly PortDescriptor[];
}

export const defineFeature = <
  const Id extends string,
  Contract extends FeatureContractDescriptor,
  const Dependencies extends readonly ContractReference[],
  const Operations extends readonly AnyOperationDescriptor[],
  const Invariants extends readonly InvariantDescriptor[],
>(definition: {
  readonly id: Id;
  readonly contract: Contract;
  readonly dependencies: Dependencies;
  readonly operations: Operations;
  readonly invariants: Invariants;
  readonly events?: readonly EventDescriptor[];
  readonly ports?: readonly PortDescriptor[];
}): FeatureDescriptor<Id, Contract, Dependencies, Operations, Invariants> => {
  assertStableId(definition.id, "Feature");
  if (definition.contract.id !== definition.id) {
    throw new TypeError(
      `Feature ${definition.id} must use a contract with the same id; received ${definition.contract.id}`,
    );
  }
  return Object.freeze({
    descriptorType: "feature",
    id: definition.id,
    contract: definition.contract,
    dependencies: Object.freeze([...definition.dependencies]) as Dependencies,
    operations: Object.freeze([...definition.operations]) as Operations,
    invariants: Object.freeze([...definition.invariants]) as Invariants,
    events: Object.freeze([...(definition.events ?? [])]),
    ports: Object.freeze([...(definition.ports ?? [])]),
  });
};

export const feature = defineFeature;

const validateOperationDefinition = (definition: {
  readonly id: string;
  readonly permissions: readonly string[];
  readonly effects: EffectMap;
  readonly errors: ErrorSchemaMap;
}): void => {
  assertStableId(definition.id, "Operation");
  const permissionSet = new Set<string>();
  for (const permission of definition.permissions) {
    assertStableId(permission, "Permission");
    if (permissionSet.has(permission)) {
      throw new TypeError(`Duplicate permission ${JSON.stringify(permission)}`);
    }
    permissionSet.add(permission);
  }
  assertUniqueDescriptorIds(definition.effects, `${definition.id} effect`);
  for (const code of Object.keys(definition.errors)) {
    assertStableId(code, `${definition.id} error code`);
  }
};

const assertUniqueDescriptorIds = (
  descriptors: Readonly<Record<string, { readonly id: string }>>,
  label: string,
): void => {
  const ids = new Set<string>();
  for (const descriptor of Object.values(descriptors)) {
    if (ids.has(descriptor.id)) {
      throw new TypeError(`Duplicate ${label} id ${JSON.stringify(descriptor.id)}`);
    }
    ids.add(descriptor.id);
  }
};

const assertStableId = (id: string, label: string): void => {
  if (id.trim().length === 0 || /\s/u.test(id)) {
    throw new TypeError(`${label} id must be a non-empty string without whitespace`);
  }
};

const freezeRecord = <T extends Readonly<Record<string, unknown>>>(value: T): T =>
  Object.freeze({ ...value }) as T;

const freezeStrings = (value: readonly string[]): readonly string[] =>
  Object.freeze([...value]);
