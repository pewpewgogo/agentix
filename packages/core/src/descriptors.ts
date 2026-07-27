import {
  array,
  boolean,
  object,
  optional,
  type Infer,
  type ObjectOutput,
  type ObjectSchema,
  type Schema,
  type SchemaShape,
} from "./schema.js";

export type MaybePromise<T> = T | Promise<T>;

export type EffectKind = "read" | "write" | "time" | "random" | "external";

/* ------------------------------------------------------------------ */
/* Errors: unified { http?, details? } declarations (amendment A7)    */
/* ------------------------------------------------------------------ */

export interface ErrorConfig {
  readonly http?: number;
  readonly details?: Schema<unknown> | SchemaShape;
}

/** A bare Schema value is shorthand for `{ details: schema }`. */
export type ErrorSpec = Schema<unknown> | ErrorConfig;

export type ErrorSpecMap = Readonly<Record<string, ErrorSpec>>;

export type ErrorDetails<Spec> = Spec extends Schema<infer T>
  ? T
  : Spec extends { readonly details: infer D }
    ? D extends Schema<infer T>
      ? T
      : D extends infer Shape extends SchemaShape
        ? ObjectOutput<Shape>
        : never
    : Record<string, never>;

export type DeclaredError<Errors extends ErrorSpecMap> = {
  [Code in keyof Errors & string]: Readonly<{
    code: Code;
    details: ErrorDetails<Errors[Code]>;
  }>;
}[keyof Errors & string];

/**
 * Marks failures produced by the injected `fail` so plain outputs stay
 * unambiguous. Registered via Symbol.for so the brand survives duplicate
 * module copies in one process (mismatched pins, non-deduped bundles):
 * a fail(...) from one copy is still recognized by another copy's dispatch.
 */
export const FAIL_RESULT: unique symbol = Symbol.for("agentix.fail");

export interface OperationFailure<E> {
  readonly [FAIL_RESULT]: true;
  readonly ok: false;
  readonly error: E;
}

type FailArgs<Spec> = Spec extends Schema<infer T>
  ? [details: T]
  : Spec extends { readonly details: infer D }
    ? D extends Schema<infer T>
      ? [details: T]
      : D extends infer Shape extends SchemaShape
        ? [details: ObjectOutput<Shape>]
        : never
    : [details?: Record<string, never>];

export type FailFn<Errors extends ErrorSpecMap> = <Code extends keyof Errors & string>(
  code: Code,
  ...details: FailArgs<Errors[Code]>
) => OperationFailure<DeclaredError<Errors>>;

/* ------------------------------------------------------------------ */
/* Ports                                                              */
/* ------------------------------------------------------------------ */

export interface UnboundPortOperation<
  Kind extends EffectKind = EffectKind,
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
> {
  readonly descriptorType: "port-operation";
  readonly kind: Kind;
  readonly input: Input;
  readonly output: Output;
}

export interface PortOperationDescriptor<
  Id extends string = string,
  Kind extends EffectKind = EffectKind,
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
> extends UnboundPortOperation<Kind, Input, Output> {
  readonly id: Id;
  readonly portId: string;
  readonly opKey: string;
  /** Set for ops minted by a port preset (port.store) so tooling can detect them exactly. */
  readonly preset?: "store";
}

export type AnyPortOperation = PortOperationDescriptor;

export type BoundPortOperations<PortId extends string, Ops> = {
  readonly [K in keyof Ops & string]: Ops[K] extends UnboundPortOperation<
    infer Kind,
    infer Input,
    infer Output
  >
    ? PortOperationDescriptor<`${PortId}.${K}`, Kind, Input, Output>
    : never;
};

/**
 * Effect functions injected into execute. Amendment A1: effects return plain
 * (validated) values; unexpected adapter failures become dispatch faults.
 */
export type EffectHandler<Operation extends AnyPortOperation> = (
  input: Infer<Operation["input"]>,
) => Promise<Infer<Operation["output"]>>;

/** Adapter implementations return plain values or throw (no Outcome wrapping). */
export type AdapterHandler<Operation extends AnyPortOperation> = (
  input: Infer<Operation["input"]>,
) => MaybePromise<Infer<Operation["output"]>>;

// The conditional guard is load-bearing: it keeps specific instantiations
// assignable to the Any* top types under strictFunctionTypes.
export type PortImplementation<Ops extends Record<string, AnyPortOperation>> = {
  readonly [K in keyof Ops]: Ops[K] extends AnyPortOperation
    ? AdapterHandler<Ops[K]>
    : never;
};

// Non-generic on purpose: keeps PortDescriptor.Ops covariant. The runtime
// carries the specific handlers; the type system treats them opaquely.
export interface BoundPortAdapter {
  readonly descriptorType: "port-adapter";
  readonly portId: string;
  readonly operations: Readonly<Record<string, (input: never) => unknown>>;
}

export interface PortDescriptor<
  Id extends string = string,
  Ops extends Record<string, AnyPortOperation> = Record<string, AnyPortOperation>,
> {
  readonly descriptorType: "port";
  readonly id: Id;
  readonly operations: Ops;
  adapter(implementation: PortImplementation<Ops>): BoundPortAdapter;
}

export type AnyPort = PortDescriptor;

// Validation intersection: rejects non-port-op properties at the call site
// WITHOUT giving the argument a concrete contextual type (which would poison
// inner generic defaults).
export type ValidPortOps<Ops> = {
  readonly [K in keyof Ops]: Ops[K] extends UnboundPortOperation
    ? Ops[K]
    : UnboundPortOperation;
};

export interface PortOperationFactory<Kind extends EffectKind> {
  <Input extends Schema<unknown>, Output extends Schema<unknown>>(definition: {
    readonly input: Input;
    readonly output: Output;
  }): UnboundPortOperation<Kind, Input, Output>;
}

export type StoreShape = SchemaShape & { readonly id: Schema<unknown> };

export type StoreOperations<PortId extends string, Shape extends StoreShape> = {
  readonly get: PortOperationDescriptor<
    `${PortId}.get`,
    "read",
    Shape["id"],
    Schema<ObjectOutput<Shape> | undefined>
  >;
  readonly save: PortOperationDescriptor<
    `${PortId}.save`,
    "write",
    ObjectSchema<Shape>,
    ObjectSchema<Shape>
  >;
  readonly delete: PortOperationDescriptor<
    `${PortId}.delete`,
    "write",
    Shape["id"],
    Schema<boolean>
  >;
  readonly list: PortOperationDescriptor<
    `${PortId}.list`,
    "read",
    ObjectSchema<Record<never, never>>,
    Schema<readonly ObjectOutput<Shape>[]>
  >;
};

export type StorePort<PortId extends string, Shape extends StoreShape> =
  PortDescriptor<PortId, StoreOperations<PortId, Shape>> &
    StoreOperations<PortId, Shape> & {
      /** Built-in Map-backed adapter keyed by the record's `id` field. */
      memory(): BoundPortAdapter;
    };

export interface PortFactory {
  <const Id extends string, const Ops extends Readonly<Record<string, unknown>>>(
    id: Id,
    operations: Ops & ValidPortOps<Ops>,
  ): PortDescriptor<Id, BoundPortOperations<Id, Ops>> & BoundPortOperations<Id, Ops>;
  readonly read: PortOperationFactory<"read">;
  readonly write: PortOperationFactory<"write">;
  readonly time: PortOperationFactory<"time">;
  readonly random: PortOperationFactory<"random">;
  readonly external: PortOperationFactory<"external">;
  store<const Id extends string, Shape extends StoreShape>(
    id: Id,
    schema: ObjectSchema<Shape>,
  ): StorePort<Id, Shape>;
}

const isSchema = (value: unknown): value is Schema<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { safeParse?: unknown }).safeParse === "function" &&
  typeof (value as { parse?: unknown }).parse === "function";

const isUnboundPortOperation = (value: unknown): value is UnboundPortOperation =>
  typeof value === "object" &&
  value !== null &&
  (value as { descriptorType?: unknown }).descriptorType === "port-operation" &&
  !("id" in value);

const isBoundPortOperation = (value: unknown): value is AnyPortOperation =>
  typeof value === "object" &&
  value !== null &&
  (value as { descriptorType?: unknown }).descriptorType === "port-operation" &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { portId?: unknown }).portId === "string" &&
  typeof (value as { opKey?: unknown }).opKey === "string";

const bindPortOperation = (
  portId: string,
  opKey: string,
  kind: EffectKind,
  input: Schema<unknown>,
  output: Schema<unknown>,
  preset?: "store",
): AnyPortOperation =>
  Object.freeze({
    descriptorType: "port-operation",
    id: `${portId}.${opKey}`,
    kind,
    input,
    output,
    portId,
    opKey,
    ...(preset === undefined ? {} : { preset }),
  });

const createAdapter = (
  portId: string,
  operations: Readonly<Record<string, AnyPortOperation>>,
  implementation: Readonly<Record<string, unknown>>,
): BoundPortAdapter => {
  const handlers: Record<string, (input: never) => unknown> = {};
  for (const key of Object.keys(operations)) {
    const handler = implementation[key];
    if (typeof handler !== "function") {
      throw new TypeError(
        `Adapter for port ${portId} must implement operation ${JSON.stringify(key)}`,
      );
    }
    handlers[key] = handler as (input: never) => unknown;
  }
  return Object.freeze({
    descriptorType: "port-adapter",
    portId,
    operations: Object.freeze(handlers),
  });
};

/**
 * Builds the port descriptor and attaches each operation as a top-level
 * property (amendment A4), colliding-checked against reserved keys.
 */
const createPortObject = (
  id: string,
  operations: Readonly<Record<string, AnyPortOperation>>,
): Record<string, unknown> => {
  const frozenOperations = Object.freeze({ ...operations });
  const descriptor: Record<string, unknown> = {
    descriptorType: "port",
    id,
    operations: frozenOperations,
    adapter: (implementation: Readonly<Record<string, unknown>>) =>
      createAdapter(id, frozenOperations, implementation),
  };
  for (const key of Object.keys(frozenOperations)) {
    if (key in descriptor) {
      throw new TypeError(
        `Port ${id} operation key ${JSON.stringify(key)} collides with a reserved port property`,
      );
    }
    descriptor[key] = frozenOperations[key];
  }
  return descriptor;
};

const portFunction = (
  id: string,
  operations: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  assertStableId(id, "Port");
  const bound: Record<string, AnyPortOperation> = {};
  for (const key of Object.keys(operations)) {
    const operation = operations[key];
    if (!isUnboundPortOperation(operation)) {
      throw new TypeError(
        `Port ${id} operation ${JSON.stringify(key)} must be created with port.read/write/time/random/external`,
      );
    }
    assertOperationKey(key, `Port ${id}`);
    bound[key] = bindPortOperation(id, key, operation.kind, operation.input, operation.output);
  }
  return Object.freeze(createPortObject(id, bound));
};

const portOperationFactory =
  (kind: EffectKind) =>
  (definition: { readonly input: Schema<unknown>; readonly output: Schema<unknown> }): UnboundPortOperation => {
    if (!isSchema(definition.input) || !isSchema(definition.output)) {
      throw new TypeError(`Port operation (${kind}) requires input and output schemas`);
    }
    return Object.freeze({
      descriptorType: "port-operation",
      kind,
      input: definition.input,
      output: definition.output,
    });
  };

const storeFunction = (
  id: string,
  schema: ObjectSchema<SchemaShape>,
): Record<string, unknown> => {
  assertStableId(id, "Port");
  if (!isSchema(schema) || !("shape" in schema)) {
    throw new TypeError(`port.store(${JSON.stringify(id)}) requires an object schema`);
  }
  const idSchema = schema.shape["id"];
  if (idSchema === undefined) {
    throw new TypeError(
      `port.store(${JSON.stringify(id)}) requires an object schema with an "id" field`,
    );
  }
  const operations: Record<string, AnyPortOperation> = {
    get: bindPortOperation(id, "get", "read", idSchema, optional(schema), "store"),
    save: bindPortOperation(id, "save", "write", schema, schema, "store"),
    delete: bindPortOperation(id, "delete", "write", idSchema, boolean(), "store"),
    list: bindPortOperation(id, "list", "read", object({}), array(schema), "store"),
  };
  const descriptor = createPortObject(id, operations);
  descriptor["memory"] = (): BoundPortAdapter => {
    const records = new Map<unknown, unknown>();
    return Object.freeze({
      descriptorType: "port-adapter",
      portId: id,
      operations: Object.freeze({
        get: (key: unknown) => records.get(key),
        save: (value: unknown) => {
          records.set((value as { id: unknown }).id, value);
          return value;
        },
        delete: (key: unknown) => records.delete(key),
        list: () => [...records.values()],
      }) as BoundPortAdapter["operations"],
    });
  };
  return Object.freeze(descriptor);
};

export const port: PortFactory = Object.freeze(
  Object.assign(portFunction, {
    read: portOperationFactory("read"),
    write: portOperationFactory("write"),
    time: portOperationFactory("time"),
    random: portOperationFactory("random"),
    external: portOperationFactory("external"),
    store: storeFunction,
  }),
) as unknown as PortFactory;

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

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

export const event = <
  const Id extends string,
  const Version extends number,
  Payload extends Schema<unknown>,
>(
  id: Id,
  version: Version,
  payload: Payload,
): EventDescriptor<Id, Version, Payload> => {
  assertStableId(id, "Event");
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("Event version must be a positive safe integer");
  }
  if (!isSchema(payload)) {
    throw new TypeError(`Event ${id} requires a payload schema`);
  }
  return Object.freeze({ descriptorType: "event", id, version, payload });
};

const isEventDescriptor = (value: unknown): value is EventDescriptor =>
  typeof value === "object" &&
  value !== null &&
  (value as { descriptorType?: unknown }).descriptorType === "event";

/* ------------------------------------------------------------------ */
/* Operations: command/query (unbound), bound by feature()            */
/* ------------------------------------------------------------------ */

export type EffectMap = Readonly<Record<string, AnyPortOperation>>;
export type EventMap = Readonly<Record<string, EventDescriptor>>;

export type EffectContext<Effects extends EffectMap> = {
  readonly [Name in keyof Effects]: Effects[Name] extends AnyPortOperation
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

export interface ExecutionContext<
  Input extends Schema<unknown>,
  Errors extends ErrorSpecMap,
  Effects extends EffectMap,
  Emits extends EventMap,
> {
  readonly input: Infer<Input>;
  readonly effects: EffectContext<Effects>;
  readonly emit: EventEmitter<Emits>;
  readonly fail: FailFn<Errors>;
}

/** Execute returns a plain output value, or a `fail(...)` result. */
export type ExecuteResult<
  Output extends Schema<unknown>,
  Errors extends ErrorSpecMap,
> = MaybePromise<Infer<Output> | OperationFailure<DeclaredError<Errors>>>;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Authored http metadata; per-error statuses live on the error declarations. */
export interface AuthoredHttp {
  readonly method: HttpMethod;
  readonly path: string;
  readonly status?: number;
}

// Stored on descriptors: variance-neutral (no keyof Errors here). errorStatus
// is DERIVED from the unified error declarations' `http` numbers.
export interface HttpMetadata {
  readonly method: HttpMethod;
  readonly path: string;
  readonly status?: number;
  readonly errorStatus: Readonly<Record<string, number>>;
}

export interface EnsureContext<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

export interface OperationEnsure {
  readonly evidence?: Schema<unknown>;
  // Method syntax on purpose: bivariant, so typed authored checks stay assignable.
  check(context: EnsureContext<unknown, unknown>): boolean;
}

export type EnsuresMap = Readonly<Record<string, OperationEnsure>>;

type AuthoredEnsures<
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
> = Readonly<
  Record<
    string,
    {
      readonly evidence?: Schema<unknown>;
      readonly check: (context: EnsureContext<Infer<Input>, Infer<Output>>) => boolean;
    }
  >
>;

export interface UnboundOperation<
  Kind extends "command" | "query" = "command" | "query",
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSpecMap = ErrorSpecMap,
  Effects extends EffectMap = EffectMap,
  Emits extends EventMap = EventMap,
> {
  readonly descriptorType: "operation";
  readonly kind: Kind;
  readonly input: Input;
  readonly output: Output;
  readonly errors: Errors;
  /** Normalized details schema per declared error code (runtime validation). */
  readonly errorDetails: Readonly<Record<string, Schema<unknown>>>;
  readonly permissions: readonly string[];
  readonly http?: HttpMetadata;
  readonly effects: Effects;
  readonly emits: Emits;
  readonly ensures: EnsuresMap;
  /** Internal: constructs declared failures; injected into execute as `fail`. */
  readonly fail: (
    code: string,
    details?: unknown,
  ) => OperationFailure<Readonly<{ code: string; details: unknown }>>;
  // Method syntax on purpose: params are bivariant positions during variance
  // measurement, so Input/Errors/Effects/Emits stay covariant here.
  execute(
    context: ExecutionContext<Input, Errors, Effects, Emits>,
  ): ExecuteResult<Output, Errors>;
}

export type AnyUnboundOperation = UnboundOperation;

export interface BoundOperation<
  Id extends string = string,
  Kind extends "command" | "query" = "command" | "query",
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSpecMap = ErrorSpecMap,
  Effects extends EffectMap = EffectMap,
  Emits extends EventMap = EventMap,
> extends UnboundOperation<Kind, Input, Output, Errors, Effects, Emits> {
  readonly id: Id;
}

export type AnyBoundOperation = BoundOperation;

export interface CommandDefinition<
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  Errors extends ErrorSpecMap,
  Effects extends EffectMap,
  Emits extends EventMap,
> {
  readonly input: Input;
  readonly output: Output;
  readonly errors?: Errors;
  readonly permissions?: readonly string[];
  readonly http?: AuthoredHttp;
  readonly effects?: Effects;
  readonly emits?: Emits;
  readonly ensures?: AuthoredEnsures<Input, Output>;
  readonly execute: (
    context: ExecutionContext<Input, Errors, Effects, Emits>,
  ) => ExecuteResult<Output, Errors>;
}

// Type-level guard: query effects may not include writes.
export type WithoutWriteEffects<Effects extends EffectMap> = {
  readonly [Name in keyof Effects]: Effects[Name]["kind"] extends "write"
    ? never
    : Effects[Name];
};

export interface QueryDefinition<
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  Errors extends ErrorSpecMap,
  Effects extends EffectMap,
> {
  readonly input: Input;
  readonly output: Output;
  readonly errors?: Errors;
  readonly permissions?: readonly string[];
  readonly http?: AuthoredHttp;
  readonly effects?: Effects & WithoutWriteEffects<Effects>;
  readonly ensures?: AuthoredEnsures<Input, Output>;
  readonly execute: (
    context: ExecutionContext<Input, Errors, Effects, Record<never, never>>,
  ) => ExecuteResult<Output, Errors>;
}

interface LooseOperationDefinition {
  readonly input: Schema<unknown>;
  readonly output: Schema<unknown>;
  readonly errors?: ErrorSpecMap;
  readonly permissions?: readonly string[];
  readonly http?: AuthoredHttp;
  readonly effects?: Readonly<Record<string, unknown>>;
  readonly emits?: Readonly<Record<string, unknown>>;
  readonly ensures?: Readonly<Record<string, unknown>>;
  readonly execute: (context: never) => unknown;
}

export const command = <
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  const Errors extends ErrorSpecMap = Record<never, never>,
  const Effects extends EffectMap = Record<never, never>,
  const Emits extends EventMap = Record<never, never>,
>(
  definition: CommandDefinition<Input, Output, Errors, Effects, Emits>,
): UnboundOperation<"command", Input, Output, Errors, Effects, Emits> =>
  buildOperation(
    "command",
    definition as unknown as LooseOperationDefinition,
  ) as unknown as UnboundOperation<"command", Input, Output, Errors, Effects, Emits>;

export const query = <
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  const Errors extends ErrorSpecMap = Record<never, never>,
  const Effects extends EffectMap = Record<never, never>,
>(
  definition: QueryDefinition<Input, Output, Errors, Effects>,
): UnboundOperation<"query", Input, Output, Errors, Effects, Record<never, never>> =>
  buildOperation(
    "query",
    definition as unknown as LooseOperationDefinition,
  ) as unknown as UnboundOperation<
    "query",
    Input,
    Output,
    Errors,
    Effects,
    Record<never, never>
  >;

const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Statuses that forbid a response body (RFC 9110) — the fixed JSON envelope always has one. */
const BODILESS_HTTP_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * Authored statuses must be carryable by the fixed JSON envelope: an integer
 * in 200..599, excluding the bodiless 204/205/304 (1xx is informational and
 * cannot carry a final response body either).
 */
const assertEnvelopeStatus = (status: number, label: string): void => {
  if (!Number.isSafeInteger(status) || status < 200 || status > 599) {
    throw new TypeError(
      `${label} must be an integer in 200..599 (1xx responses cannot carry the JSON envelope)`,
    );
  }
  if (BODILESS_HTTP_STATUSES.has(status)) {
    throw new TypeError(
      `${label} cannot be ${status}: 204, 205, and 304 forbid a response body, but every response carries the JSON envelope`,
    );
  }
};

const buildOperation = (
  kind: "command" | "query",
  definition: LooseOperationDefinition,
): AnyUnboundOperation => {
  if (!isSchema(definition.input) || !isSchema(definition.output)) {
    throw new TypeError(`${kind}() requires input and output schemas`);
  }
  if (typeof definition.execute !== "function") {
    throw new TypeError(`${kind}() requires an execute function`);
  }

  const errors = Object.freeze({ ...(definition.errors ?? {}) });
  // Null prototypes: error codes are caller-controlled lookup keys.
  const errorDetails: Record<string, Schema<unknown>> = Object.create(null);
  const errorStatus: Record<string, number> = Object.create(null);
  const emptyDetailCodes = new Set<string>();
  for (const code of Object.keys(errors)) {
    assertStableId(code, "Error code");
    const spec = errors[code];
    if (spec === undefined) continue;
    if (isSchema(spec)) {
      errorDetails[code] = spec;
      continue;
    }
    if (typeof spec !== "object" || spec === null) {
      throw new TypeError(
        `Error ${code} must be a schema or an { http?, details? } declaration`,
      );
    }
    const { http, details } = spec;
    if (http !== undefined) {
      assertEnvelopeStatus(http, `Error ${code} http status`);
      errorStatus[code] = http;
    }
    if (details === undefined) {
      errorDetails[code] = EMPTY_DETAILS;
      emptyDetailCodes.add(code);
    } else if (isSchema(details)) {
      errorDetails[code] = details;
    } else if (typeof details === "object" && details !== null) {
      errorDetails[code] = object(details);
    } else {
      throw new TypeError(
        `Error ${code} details must be a schema or a record of schemas`,
      );
    }
  }

  const permissions = validatePermissions(definition.permissions ?? []);

  const effects = Object.freeze({ ...(definition.effects ?? {}) });
  const effectIds = new Set<string>();
  for (const alias of Object.keys(effects)) {
    assertNotReservedKey(alias, "Effect alias");
    const effect = effects[alias];
    if (!isBoundPortOperation(effect)) {
      throw new TypeError(
        `Effect ${JSON.stringify(alias)} must reference a port operation (Port.opName)`,
      );
    }
    if (effectIds.has(effect.id)) {
      throw new TypeError(`Duplicate effect id ${JSON.stringify(effect.id)}`);
    }
    effectIds.add(effect.id);
    if (kind === "query" && effect.kind === "write") {
      throw new TypeError(`Query cannot declare write effect ${effect.id}`);
    }
  }

  const emits = Object.freeze({ ...(definition.emits ?? {}) });
  const eventIds = new Set<string>();
  for (const alias of Object.keys(emits)) {
    const emitted = emits[alias];
    if (!isEventDescriptor(emitted)) {
      throw new TypeError(`Emit ${JSON.stringify(alias)} must reference an event()`);
    }
    if (eventIds.has(emitted.id)) {
      throw new TypeError(`Duplicate emitted event id ${JSON.stringify(emitted.id)}`);
    }
    eventIds.add(emitted.id);
  }

  const ensures = Object.freeze({ ...(definition.ensures ?? {}) });
  for (const name of Object.keys(ensures)) {
    const ensure = ensures[name] as { check?: unknown; evidence?: unknown } | undefined;
    if (ensure === undefined || typeof ensure !== "object" || typeof ensure.check !== "function") {
      throw new TypeError(`Ensure ${JSON.stringify(name)} requires a check function`);
    }
    if (ensure.evidence !== undefined && !isSchema(ensure.evidence)) {
      throw new TypeError(`Ensure ${JSON.stringify(name)} evidence must be a schema`);
    }
  }

  let http: HttpMetadata | undefined;
  if (definition.http !== undefined) {
    const { method, path, status } = definition.http;
    if (!HTTP_METHODS.has(method)) {
      throw new TypeError(`http.method must be one of ${[...HTTP_METHODS].join(", ")}`);
    }
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError('http.path must be a string starting with "/"');
    }
    if (status !== undefined) assertEnvelopeStatus(status, "http.status");
    http = Object.freeze({
      method,
      path,
      ...(status === undefined ? {} : { status }),
      errorStatus: Object.freeze(errorStatus),
    });
  }

  const fail = (
    code: string,
    details?: unknown,
  ): OperationFailure<Readonly<{ code: string; details: unknown }>> => ({
    [FAIL_RESULT]: true,
    ok: false,
    error: {
      code,
      details: details === undefined && emptyDetailCodes.has(code) ? {} : details,
    },
  });

  return Object.freeze({
    descriptorType: "operation",
    kind,
    input: definition.input,
    output: definition.output,
    errors,
    errorDetails: Object.freeze(errorDetails),
    permissions,
    ...(http === undefined ? {} : { http }),
    effects,
    emits,
    ensures,
    fail,
    execute: definition.execute,
  }) as unknown as AnyUnboundOperation;
};

const EMPTY_DETAILS = object({});

/* ------------------------------------------------------------------ */
/* feature(id, { operations }) -> ids derived `${featureId}.${key}`   */
/* ------------------------------------------------------------------ */

export type BindOperations<FeatureId extends string, Ops> = {
  readonly [K in keyof Ops & string]: Ops[K] extends UnboundOperation<
    infer Kind,
    infer Input,
    infer Output,
    infer Errors,
    infer Effects,
    infer Emits
  >
    ? BoundOperation<`${FeatureId}.${K}`, Kind, Input, Output, Errors, Effects, Emits>
    : never;
};

export interface FeatureDescriptor<
  Id extends string = string,
  Ops extends Record<string, AnyBoundOperation> = Record<string, AnyBoundOperation>,
> {
  readonly descriptorType: "feature";
  readonly id: Id;
  readonly operations: Ops;
  readonly events: readonly EventDescriptor[];
}

export type AnyFeature = FeatureDescriptor;

export type ValidOperations<Ops> = {
  readonly [K in keyof Ops]: Ops[K] extends AnyUnboundOperation
    ? Ops[K]
    : AnyUnboundOperation;
};

const isOperationDescriptor = (value: unknown): value is AnyUnboundOperation =>
  typeof value === "object" &&
  value !== null &&
  (value as { descriptorType?: unknown }).descriptorType === "operation";

export const feature = <
  const Id extends string,
  const Ops extends Readonly<Record<string, unknown>>,
>(
  id: Id,
  definition: {
    readonly operations: Ops & ValidOperations<Ops>;
    readonly events?: readonly EventDescriptor[];
  },
): FeatureDescriptor<Id, BindOperations<Id, Ops>> => {
  assertStableId(id, "Feature");
  const source = definition.operations as Readonly<Record<string, unknown>>;
  const operations: Record<string, AnyBoundOperation> = {};
  for (const key of Object.keys(source)) {
    const operation = source[key];
    if (!isOperationDescriptor(operation)) {
      throw new TypeError(
        `Feature ${id} operation ${JSON.stringify(key)} must be created with command() or query()`,
      );
    }
    assertOperationKey(key, `Feature ${id}`);
    operations[key] = Object.freeze({
      ...operation,
      id: `${id}.${key}`,
    }) as AnyBoundOperation;
  }
  const events = Object.freeze([...(definition.events ?? [])]);
  for (const emitted of events) {
    if (!isEventDescriptor(emitted)) {
      throw new TypeError(`Feature ${id} events must be created with event()`);
    }
  }
  return Object.freeze({
    descriptorType: "feature",
    id,
    operations: Object.freeze(operations),
    events,
  }) as unknown as FeatureDescriptor<Id, BindOperations<Id, Ops>>;
};

/* ------------------------------------------------------------------ */
/* Shared validation helpers                                          */
/* ------------------------------------------------------------------ */

const validatePermissions = (permissions: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  for (const permission of permissions) {
    assertStableId(permission, "Permission");
    if (seen.has(permission)) {
      throw new TypeError(`Duplicate permission ${JSON.stringify(permission)}`);
    }
    seen.add(permission);
  }
  return Object.freeze([...permissions]);
};

/**
 * Names whose assignment on a plain object is silently swallowed
 * (prototype-polluting) instead of creating an own property. Rejected for
 * every feature/operation/port/error/effect identifier so a declared key can
 * never vanish from a built record.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const assertNotReservedKey = (key: string, label: string): void => {
  if (RESERVED_KEYS.has(key)) {
    throw new TypeError(
      `${label} ${JSON.stringify(key)} is a reserved (prototype-polluting) name`,
    );
  }
};

const assertStableId = (id: string, label: string): void => {
  if (typeof id !== "string" || id.trim().length === 0 || /\s/u.test(id)) {
    throw new TypeError(`${label} id must be a non-empty string without whitespace`);
  }
  assertNotReservedKey(id, `${label} id`);
};

const assertOperationKey = (key: string, owner: string): void => {
  if (key.length === 0 || /[\s.]/u.test(key)) {
    throw new TypeError(
      `${owner} operation key ${JSON.stringify(key)} must be non-empty without whitespace or dots`,
    );
  }
  assertNotReservedKey(key, `${owner} operation key`);
};
