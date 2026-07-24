import {
  type AnyOperationDescriptor,
  type AnyPortOperationDescriptor,
  type BoundPortAdapter,
  type DeclaredError,
  type EffectContext,
  type EffectMap,
  type EventDescriptor,
  type EventEmitter,
  type EventMap,
  type FeatureDescriptor,
  type InvariantDescriptor,
  type OperationDescriptor,
  type PortDescriptor,
} from "./descriptors.js";
import { isOutcome, type Outcome } from "./outcome.js";
import type { Infer, SchemaIssue } from "./schema.js";

export type RuntimeMode = "production" | "development" | "test";

export interface Principal {
  readonly id: string;
  readonly permissions: readonly string[] | ReadonlySet<string>;
}

export const principal = (
  id: string,
  permissions: readonly string[],
): Principal => Object.freeze({ id, permissions: Object.freeze([...permissions]) });

export interface EffectTraceEntry {
  readonly type: "effect";
  readonly operationId: string;
  readonly alias: string;
  readonly effectId: string;
  readonly input: unknown;
  readonly status: "completed" | "fault";
  readonly outcome?: Outcome<unknown, unknown>;
  readonly error?: DispatchFaultError;
}

export interface EventTraceEntry {
  readonly type: "event";
  readonly operationId: string;
  readonly alias: string;
  readonly eventId: string;
  readonly version: number;
  readonly payload: unknown;
}

export interface EmittedEvent {
  readonly operationId: string;
  readonly alias: string;
  readonly eventId: string;
  readonly version: number;
  readonly payload: unknown;
}

export type TraceEntry = EffectTraceEntry | EventTraceEntry;
export type ExecutionTrace = readonly TraceEntry[];

export interface UnknownOperationError {
  readonly code: "UNKNOWN_OPERATION";
  readonly operationId: string;
}

export interface PermissionDeniedError {
  readonly code: "PERMISSION_DENIED";
  readonly principalId: string;
  readonly missingPermissions: readonly string[];
}

export interface InvalidInputError {
  readonly code: "INVALID_INPUT";
  readonly issues: readonly SchemaIssue[];
}

export type DispatchRejectionError =
  | UnknownOperationError
  | PermissionDeniedError
  | InvalidInputError;

export type DispatchFaultCode =
  | "INPUT_VALIDATION_FAILED"
  | "INVALID_OPERATION_OUTCOME"
  | "INVALID_OUTPUT"
  | "INVALID_DOMAIN_ERROR"
  | "INVALID_EFFECT_INPUT"
  | "INVALID_EFFECT_RESULT"
  | "INVALID_EFFECT_OUTPUT"
  | "INVALID_EFFECT_ERROR"
  | "EFFECT_EXECUTION_FAILED"
  | "INVALID_EVENT_PAYLOAD"
  | "EVENT_OUTSIDE_EXECUTION"
  | "EFFECT_OUTSIDE_EXECUTION"
  | "UNDECLARED_EFFECT"
  | "OPERATION_DESCRIPTOR_MISMATCH"
  | "EXECUTION_FAILED";

export interface DispatchFaultError {
  readonly code: DispatchFaultCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly issues?: readonly SchemaIssue[];
  readonly effectId?: string;
  readonly eventId?: string;
}

export interface CompletedDispatch<T, E> {
  readonly kind: "completed";
  readonly operationId: string;
  readonly outcome: Outcome<T, E>;
  /** Validated events emitted by a completed operation; publication is caller-owned. */
  readonly events: readonly EmittedEvent[];
  readonly trace?: ExecutionTrace;
}

export interface RejectedDispatch {
  readonly kind: "rejected";
  readonly operationId?: string;
  readonly error: DispatchRejectionError;
  readonly trace?: ExecutionTrace;
}

export interface FaultedDispatch {
  readonly kind: "fault";
  readonly operationId: string;
  readonly error: DispatchFaultError;
  readonly trace?: ExecutionTrace;
}

export type DispatchResult<T = unknown, E = unknown> =
  | CompletedDispatch<T, E>
  | RejectedDispatch
  | FaultedDispatch;

export interface DispatchOptions<Input = unknown> {
  readonly input: Input;
  readonly principal: Principal;
  /** Overrides the application's trace default for this dispatch. */
  readonly trace?: boolean;
}

export type DispatchRequest<Input = unknown> = DispatchOptions<Input>;

type InputOf<Operation extends AnyOperationDescriptor> = Infer<Operation["input"]>;
type OutputOf<Operation extends AnyOperationDescriptor> = Infer<Operation["output"]>;
type ErrorOf<Operation extends AnyOperationDescriptor> = DeclaredError<
  Operation["errors"]
>;

export interface Application<
  Operations extends AnyOperationDescriptor = AnyOperationDescriptor,
> {
  readonly features: readonly FeatureDescriptor[];
  readonly operations: readonly Operations[];
  readonly mode: RuntimeMode;
  getOperation(id: string): Operations | undefined;
  dispatch<Operation extends Operations>(
    operation: Operation,
    options: DispatchOptions<InputOf<Operation>>,
  ): Promise<DispatchResult<OutputOf<Operation>, ErrorOf<Operation>>>;
  dispatch(
    operationId: string,
    options: DispatchOptions<unknown>,
  ): Promise<DispatchResult<unknown, unknown>>;
}

export type AdapterCollection =
  | readonly BoundPortAdapter[]
  | Readonly<Record<string, BoundPortAdapter>>;

export interface ApplicationDefinition<
  Features extends readonly FeatureDescriptor[],
> {
  readonly features: Features;
  readonly adapters: AdapterCollection;
  readonly mode?: RuntimeMode;
  /** Defaults on in development/test and off in production. */
  readonly trace?: boolean;
}

export type OperationsFromFeatures<
  Features extends readonly FeatureDescriptor[],
> = Features[number]["operations"][number];

export type ApplicationDefinitionIssueCode =
  | "DUPLICATE_ID"
  | "DUPLICATE_DEPENDENCY"
  | "MISSING_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "QUERY_WRITE_EFFECT"
  | "QUERY_EMITS_EVENT"
  | "DUPLICATE_ADAPTER"
  | "ADAPTER_PORT_MISMATCH"
  | "INCOMPLETE_ADAPTER"
  | "MISSING_ADAPTER";

export interface ApplicationDefinitionIssue {
  readonly code: ApplicationDefinitionIssueCode;
  readonly message: string;
  readonly id?: string;
}

export class ApplicationDefinitionError extends TypeError {
  readonly issues: readonly ApplicationDefinitionIssue[];

  constructor(issues: readonly ApplicationDefinitionIssue[]) {
    super(issues.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
    this.name = "ApplicationDefinitionError";
    this.issues = Object.freeze([...issues]);
  }
}

interface ExecutionLifecycle {
  active: boolean;
  boundaryFault?: DispatchFaultError;
  readonly pendingEffects: Set<Promise<unknown>>;
  readonly events: EmittedEvent[];
}

export const createApplication = <
  const Features extends readonly FeatureDescriptor[],
>(definition: ApplicationDefinition<Features>): Application<OperationsFromFeatures<Features>> => {
  const issues: ApplicationDefinitionIssue[] = [];
  const features = Object.freeze([...definition.features]);
  const operationsById = new Map<string, AnyOperationDescriptor>();
  const allIds = new Map<
    string,
    { readonly kind: string; readonly descriptor: object }
  >();
  const featureIds = new Set(features.map((entry) => entry.id));
  const requiredPorts = new Map<string, PortDescriptor>();

  for (const feature of features) {
    recordId(allIds, issues, feature.id, "feature", feature);
    const dependencies = new Set<string>();
    for (const dependency of feature.dependencies) {
      if (dependencies.has(dependency.id)) {
        issues.push(definitionIssue(
          "DUPLICATE_DEPENDENCY",
          `Feature ${feature.id} declares dependency ${dependency.id} more than once`,
          dependency.id,
        ));
      }
      dependencies.add(dependency.id);
      if (dependency.id === feature.id) {
        issues.push(definitionIssue(
          "SELF_DEPENDENCY",
          `Feature ${feature.id} cannot depend on itself`,
          feature.id,
        ));
      } else if (!featureIds.has(dependency.id)) {
        issues.push(definitionIssue(
          "MISSING_DEPENDENCY",
          `Feature ${feature.id} depends on missing feature ${dependency.id}`,
          dependency.id,
        ));
      }
    }

    for (const operation of feature.operations) {
      recordId(
        allIds,
        issues,
        operation.id,
        `${operation.kind} operation`,
        operation,
      );
      if (!operationsById.has(operation.id)) operationsById.set(operation.id, operation);
      validateQueryRuntime(operation, issues);
      for (const effect of Object.values(operation.effects)) {
        const existing = requiredPorts.get(effect.portId);
        if (existing === undefined) {
          requiredPorts.set(effect.portId, syntheticPort(effect));
        } else {
          requiredPorts.set(
            effect.portId,
            mergeRequiredPort(existing, effect, issues),
          );
        }
        recordId(allIds, issues, effect.id, "port operation", effect, true);
      }
      for (const emitted of Object.values(operation.emits)) {
        recordId(allIds, issues, emitted.id, "event", emitted, true);
      }
      for (const invariant of operation.invariants) {
        recordId(allIds, issues, invariant.id, "invariant", invariant, true);
      }
    }

    for (const invariant of feature.invariants) {
      recordId(allIds, issues, invariant.id, "invariant", invariant, true);
    }
    for (const emitted of feature.events) {
      recordId(allIds, issues, emitted.id, "event", emitted, true);
    }
    for (const port of feature.ports) {
      recordId(allIds, issues, port.id, "port", port, true);
      requiredPorts.set(port.id, port);
      for (const operation of Object.values(port.operations)) {
        recordId(
          allIds,
          issues,
          operation.id,
          "port operation",
          operation,
          true,
        );
      }
    }
  }

  const adapters = normalizeAdapters(definition.adapters, issues);
  validateAdapters(requiredPorts, adapters, issues);

  if (issues.length > 0) throw new ApplicationDefinitionError(issues);

  const mode = definition.mode ?? "production";
  const traceByDefault = definition.trace ?? mode !== "production";
  const operations = Object.freeze([...operationsById.values()]) as readonly OperationsFromFeatures<Features>[];

  const dispatch = async (
    requested: AnyOperationDescriptor | string,
    options: DispatchOptions<unknown>,
  ): Promise<DispatchResult<unknown, unknown>> => {
    const requestedId = typeof requested === "string" ? requested : requested.id;
    const operation = operationsById.get(requestedId);
    const traceEnabled = options.trace ?? traceByDefault;
    const trace: TraceEntry[] = [];

    if (operation === undefined) {
      return includeTrace(
        {
          kind: "rejected",
          operationId: requestedId,
          error: Object.freeze({ code: "UNKNOWN_OPERATION", operationId: requestedId }),
        },
        traceEnabled,
        trace,
      );
    }

    if (typeof requested !== "string" && requested !== operation) {
      return includeTrace(
        {
          kind: "fault",
          operationId: requestedId,
          error: fault(
            "OPERATION_DESCRIPTOR_MISMATCH",
            `Operation descriptor ${requestedId} is not the registered application descriptor`,
          ),
        },
        traceEnabled,
        trace,
      );
    }

    // Authorization deliberately precedes input parsing and context construction.
    const granted = new Set(options.principal.permissions);
    const missingPermissions = operation.permissions.filter(
      (permission) => !granted.has(permission),
    );
    if (missingPermissions.length > 0) {
      return includeTrace(
        {
          kind: "rejected",
          operationId: operation.id,
          error: Object.freeze({
            code: "PERMISSION_DENIED",
            principalId: options.principal.id,
            missingPermissions: Object.freeze(missingPermissions),
          }),
        },
        traceEnabled,
        trace,
      );
    }

    let parsedInputData: unknown;
    try {
      const parsedInput = operation.input.safeParse(options.input);
      if (!parsedInput.success) {
        return includeTrace(
          {
            kind: "rejected",
            operationId: operation.id,
            error: Object.freeze({
              code: "INVALID_INPUT",
              issues: parsedInput.issues,
            }),
          },
          traceEnabled,
          trace,
        );
      }
      parsedInputData = parsedInput.data;
    } catch (cause) {
      return includeTrace(
        {
          kind: "fault",
          operationId: operation.id,
          error: fault(
            "INPUT_VALIDATION_FAILED",
            `Input schema for operation ${operation.id} threw during validation`,
            { cause },
          ),
        },
        traceEnabled,
        trace,
      );
    }

    const lifecycle: ExecutionLifecycle = {
      active: true,
      pendingEffects: new Set(),
      events: [],
    };
    const effects = buildEffects(
      operation,
      adapters,
      lifecycle,
      trace,
    );
    const emit = buildEmitter(operation, lifecycle, trace);

    try {
      const rawOutcome = await operation.execute({
        input: parsedInputData,
        effects,
        emit,
      });
      lifecycle.active = false;
      await drainPendingEffects(lifecycle);
      if (lifecycle.boundaryFault !== undefined) {
        return includeTrace(
          { kind: "fault", operationId: operation.id, error: lifecycle.boundaryFault },
          traceEnabled,
          trace,
        );
      }
      const outcome = validateOperationOutcome(operation, rawOutcome);
      return includeTrace(
        {
          kind: "completed",
          operationId: operation.id,
          outcome,
          events: Object.freeze([...lifecycle.events]),
        },
        traceEnabled,
        trace,
      );
    } catch (cause) {
      lifecycle.active = false;
      await drainPendingEffects(lifecycle);
      const error = lifecycle.boundaryFault ?? (cause instanceof BoundaryFault
        ? cause.fault
        : fault(
            "EXECUTION_FAILED",
            `Operation ${operation.id} threw an unexpected exception`,
            { cause },
          ));
      return includeTrace(
        { kind: "fault", operationId: operation.id, error },
        traceEnabled,
        trace,
      );
    }
  };

  return Object.freeze({
    features,
    operations,
    mode,
    getOperation(id: string) {
      return operationsById.get(id) as OperationsFromFeatures<Features> | undefined;
    },
    dispatch,
  }) as unknown as Application<OperationsFromFeatures<Features>>;
};

const buildEffects = (
  operation: AnyOperationDescriptor,
  adapters: ReadonlyMap<string, BoundPortAdapter>,
  lifecycle: ExecutionLifecycle,
  trace: TraceEntry[],
): EffectContext<EffectMap> => {
  const context: Record<
    string,
    (input: unknown) => Promise<Outcome<unknown, unknown>>
  > = {};
  const declaredIds = new Set(
    Object.values(operation.effects).map((effect) => effect.id),
  );

  for (const alias of Object.keys(operation.effects).sort()) {
    const effect = operation.effects[alias];
    if (effect === undefined) continue;
    const executeEffect = async (input: unknown): Promise<Outcome<unknown, unknown>> => {
      if (!lifecycle.active) {
        throw latchBoundaryFault(lifecycle, fault(
          "EFFECT_OUTSIDE_EXECUTION",
          `Effect ${effect.id} was invoked outside ${operation.id} execution`,
          { effectId: effect.id },
        ));
      }
      if (!declaredIds.has(effect.id)) {
        throw latchBoundaryFault(lifecycle, fault(
          "UNDECLARED_EFFECT",
          `Effect ${effect.id} is not declared by ${operation.id}`,
          { effectId: effect.id },
        ));
      }

      let parsedInputData: unknown;
      try {
        const parsedInput = effect.input.safeParse(input);
        if (!parsedInput.success) {
          const boundary = fault(
            "INVALID_EFFECT_INPUT",
            `Invalid input for effect ${effect.id}`,
            { effectId: effect.id, issues: parsedInput.issues },
          );
          trace.push(effectFaultTrace(operation.id, alias, effect.id, input, boundary));
          throw latchBoundaryFault(lifecycle, boundary);
        }
        parsedInputData = parsedInput.data;
      } catch (cause) {
        if (cause instanceof BoundaryFault) throw cause;
        const boundary = fault(
          "INVALID_EFFECT_INPUT",
          `Input schema for effect ${effect.id} threw during validation`,
          { effectId: effect.id, cause },
        );
        trace.push(effectFaultTrace(operation.id, alias, effect.id, input, boundary));
        throw latchBoundaryFault(lifecycle, boundary);
      }

      const adapter = adapters.get(effect.portId);
      const handler = adapter?.operations[effect.operationKey] as
        | ((value: unknown) => unknown)
        | undefined;
      // Completeness is checked at construction; this protects hostile casts/mutation.
      if (handler === undefined) {
        const boundary = fault(
          "EFFECT_EXECUTION_FAILED",
          `No adapter handler is bound for ${effect.id}`,
          { effectId: effect.id },
        );
        trace.push(effectFaultTrace(operation.id, alias, effect.id, input, boundary));
        throw latchBoundaryFault(lifecycle, boundary);
      }

      let raw: unknown;
      try {
        raw = await handler(parsedInputData);
      } catch (cause) {
        const boundary = fault(
          "EFFECT_EXECUTION_FAILED",
          `Adapter for ${effect.id} threw an unexpected exception`,
          { effectId: effect.id, cause },
        );
        trace.push(effectFaultTrace(operation.id, alias, effect.id, input, boundary));
        throw latchBoundaryFault(lifecycle, boundary);
      }

      let inspectedOutcome: Outcome<unknown, unknown> | undefined;
      try {
        if (isOutcome(raw)) inspectedOutcome = raw;
      } catch (cause) {
        const boundary = fault(
          "INVALID_EFFECT_RESULT",
          `Could not inspect adapter result for ${effect.id}`,
          { effectId: effect.id, cause },
        );
        trace.push(effectFaultTrace(operation.id, alias, effect.id, input, boundary));
        throw latchBoundaryFault(lifecycle, boundary);
      }
      if (inspectedOutcome === undefined) {
        const boundary = fault(
          "INVALID_EFFECT_RESULT",
          `Adapter for ${effect.id} did not return an Outcome`,
          { effectId: effect.id },
        );
        trace.push(effectFaultTrace(operation.id, alias, effect.id, input, boundary));
        throw latchBoundaryFault(lifecycle, boundary);
      }

      let validated: Outcome<unknown, unknown>;
      try {
        validated = validateEffectOutcome(effect, inspectedOutcome);
      } catch (cause) {
        const boundary = cause instanceof BoundaryFault
          ? cause.fault
          : fault(
              "INVALID_EFFECT_RESULT",
              `Could not validate adapter result for ${effect.id}`,
              { effectId: effect.id, cause },
            );
        trace.push(effectFaultTrace(operation.id, alias, effect.id, input, boundary));
        throw cause instanceof BoundaryFault
          ? latchBoundaryFault(lifecycle, cause.fault)
          : latchBoundaryFault(lifecycle, boundary);
      }
      trace.push(Object.freeze({
        type: "effect",
        operationId: operation.id,
        alias,
        effectId: effect.id,
        input: parsedInputData,
        status: "completed",
        outcome: validated,
      }));
      return validated;
    };
    context[alias] = (input: unknown): Promise<Outcome<unknown, unknown>> => {
      const pending = executeEffect(input);
      lifecycle.pendingEffects.add(pending);
      void pending.then(
        () => lifecycle.pendingEffects.delete(pending),
        () => lifecycle.pendingEffects.delete(pending),
      );
      return pending;
    };
  }
  return Object.freeze(context) as EffectContext<EffectMap>;
};

const buildEmitter = (
  operation: AnyOperationDescriptor,
  lifecycle: ExecutionLifecycle,
  trace: TraceEntry[],
): EventEmitter<EventMap> => {
  const emitter: Record<string, (payload: unknown) => void> = {};
  for (const alias of Object.keys(operation.emits).sort()) {
    const emitted = operation.emits[alias];
    if (emitted === undefined) continue;
    emitter[alias] = (payload: unknown): void => {
      if (!lifecycle.active) {
        throw latchBoundaryFault(lifecycle, fault(
          "EVENT_OUTSIDE_EXECUTION",
          `Event ${emitted.id} was emitted outside ${operation.id} execution`,
          { eventId: emitted.id },
        ));
      }
      let eventPayload: unknown;
      try {
        const parsed = emitted.payload.safeParse(payload);
        if (!parsed.success) {
          throw new BoundaryFault(fault(
            "INVALID_EVENT_PAYLOAD",
            `Invalid payload for event ${emitted.id}`,
            { eventId: emitted.id, issues: parsed.issues },
          ));
        }
        eventPayload = snapshotStructuredValue(parsed.data);
      } catch (cause) {
        const boundary = cause instanceof BoundaryFault
          ? cause.fault
          : fault(
              "INVALID_EVENT_PAYLOAD",
              `Could not validate or snapshot payload for event ${emitted.id}`,
              { eventId: emitted.id, cause },
            );
        throw latchBoundaryFault(lifecycle, boundary);
      }
      const event: EmittedEvent = Object.freeze({
        operationId: operation.id,
        alias,
        eventId: emitted.id,
        version: emitted.version,
        payload: eventPayload,
      });
      lifecycle.events.push(event);
      trace.push(Object.freeze({
        type: "event",
        ...event,
      }));
    };
  }
  return Object.freeze(emitter) as EventEmitter<EventMap>;
};

/**
 * Detach and deeply freeze the structured values produced by built-in schemas.
 * The iterative walk preserves cycles and shared references without risking
 * unbounded recursive calls. Non-plain objects are opaque schema values.
 */
const snapshotStructuredValue = (value: unknown): unknown => {
  if (!isStructuredContainer(value)) return value;

  const root = createStructuredContainer(value);
  const snapshots = new WeakMap<object, object>([[value, root]]);
  const pending: object[] = [value];
  const created: object[] = [root];

  while (pending.length > 0) {
    const source = pending.pop();
    if (source === undefined) continue;
    const target = snapshots.get(source);
    if (target === undefined) continue;

    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor?.enumerable !== true) continue;

      const sourceValue = Reflect.get(source, key);
      let snapshotValue = sourceValue;
      if (isStructuredContainer(sourceValue)) {
        const existing = snapshots.get(sourceValue);
        if (existing !== undefined) {
          snapshotValue = existing;
        } else {
          const child = createStructuredContainer(sourceValue);
          snapshots.set(sourceValue, child);
          pending.push(sourceValue);
          created.push(child);
          snapshotValue = child;
        }
      }

      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value: snapshotValue,
        writable: true,
      });
    }
  }

  for (let index = created.length - 1; index >= 0; index -= 1) {
    const container = created[index];
    if (container !== undefined) Object.freeze(container);
  }
  return root;
};

const isStructuredContainer = (value: unknown): value is object => {
  if (Array.isArray(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
};

const createStructuredContainer = (source: object): object =>
  Array.isArray(source)
    ? new Array<unknown>(source.length)
    : Object.create(Object.getPrototypeOf(source) as object | null) as object;

const validateOperationOutcome = (
  operation: AnyOperationDescriptor,
  value: unknown,
): Outcome<unknown, unknown> => {
  if (!isOutcome(value)) {
    throw new BoundaryFault(fault(
      "INVALID_OPERATION_OUTCOME",
      `Operation ${operation.id} did not return an Outcome`,
    ));
  }
  if (value.ok) {
    const parsed = operation.output.safeParse(value.value);
    if (!parsed.success) {
      throw new BoundaryFault(fault(
        "INVALID_OUTPUT",
        `Operation ${operation.id} returned invalid output`,
        { issues: parsed.issues },
      ));
    }
    return Object.freeze({ ok: true, value: parsed.data });
  }
  return validateDeclaredError(operation.errors, value.error, operation.id);
};

const validateEffectOutcome = (
  effect: AnyPortOperationDescriptor,
  value: Outcome<unknown, unknown>,
): Outcome<unknown, unknown> => {
  if (value.ok) {
    const parsed = effect.output.safeParse(value.value);
    if (!parsed.success) {
      throw new BoundaryFault(fault(
        "INVALID_EFFECT_OUTPUT",
        `Adapter for ${effect.id} returned invalid output`,
        { effectId: effect.id, issues: parsed.issues },
      ));
    }
    return Object.freeze({ ok: true, value: parsed.data });
  }
  return validateDeclaredError(effect.errors, value.error, effect.id, true);
};

const validateDeclaredError = (
  schemas: Readonly<Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown; issues?: readonly SchemaIssue[] } }>>,
  value: unknown,
  ownerId: string,
  effect = false,
): Outcome<never, unknown> => {
  if (typeof value !== "object" || value === null) {
    throw new BoundaryFault(fault(
      effect ? "INVALID_EFFECT_ERROR" : "INVALID_DOMAIN_ERROR",
      `${ownerId} returned an invalid declared error`,
      effect ? { effectId: ownerId } : {},
    ));
  }
  const candidate = value as Record<string, unknown>;
  const code = candidate["code"];
  if (typeof code !== "string" || !(code in schemas)) {
    throw new BoundaryFault(fault(
      effect ? "INVALID_EFFECT_ERROR" : "INVALID_DOMAIN_ERROR",
      `${ownerId} returned undeclared error code ${String(code)}`,
      effect ? { effectId: ownerId } : {},
    ));
  }
  const parsed = schemas[code]?.safeParse(candidate["details"]);
  if (parsed === undefined || !parsed.success) {
    throw new BoundaryFault(fault(
      effect ? "INVALID_EFFECT_ERROR" : "INVALID_DOMAIN_ERROR",
      `${ownerId} returned invalid details for error ${code}`,
      {
        ...(effect ? { effectId: ownerId } : {}),
        ...(parsed?.issues === undefined ? {} : { issues: parsed.issues }),
      },
    ));
  }
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, details: parsed.data }),
  });
};

const normalizeAdapters = (
  collection: AdapterCollection,
  issues: ApplicationDefinitionIssue[],
): ReadonlyMap<string, BoundPortAdapter> => {
  const values: readonly (BoundPortAdapter | undefined)[] = Array.isArray(collection)
    ? collection
    : Object.keys(collection).sort().map(
        (key) => (collection as Readonly<Record<string, BoundPortAdapter>>)[key],
      );
  const adapters = new Map<string, BoundPortAdapter>();
  for (const adapter of values) {
    if (adapter === undefined) continue;
    if (adapters.has(adapter.port.id)) {
      issues.push(definitionIssue(
        "DUPLICATE_ADAPTER",
        `Port ${adapter.port.id} has more than one adapter`,
        adapter.port.id,
      ));
    } else {
      adapters.set(adapter.port.id, adapter);
    }
  }
  return adapters;
};

const validateAdapters = (
  required: ReadonlyMap<string, PortDescriptor>,
  adapters: ReadonlyMap<string, BoundPortAdapter>,
  issues: ApplicationDefinitionIssue[],
): void => {
  for (const [portId, port] of required) {
    const adapter = adapters.get(portId);
    if (adapter === undefined) {
      issues.push(definitionIssue(
        "MISSING_ADAPTER",
        `No adapter is bound for required port ${portId}`,
        portId,
      ));
      continue;
    }
    for (const [key, operation] of Object.entries(port.operations)) {
      const adapterOperation = adapter.port.operations[key];
      if (adapterOperation !== operation) {
        issues.push(definitionIssue(
          "ADAPTER_PORT_MISMATCH",
          `Adapter for ${portId} does not describe operation ${operation.id} at key ${key}`,
          operation.id,
        ));
      }
      if (typeof adapter.operations[key] !== "function") {
        issues.push(definitionIssue(
          "INCOMPLETE_ADAPTER",
          `Adapter for ${portId} does not implement ${operation.id}`,
          operation.id,
        ));
      }
    }
  }
};

const syntheticPort = (effect: AnyPortOperationDescriptor): PortDescriptor =>
  Object.freeze({
    descriptorType: "port",
    id: effect.portId,
    operations: Object.freeze({ [effect.operationKey]: effect }),
  });

const mergeRequiredPort = (
  current: PortDescriptor,
  effect: AnyPortOperationDescriptor,
  issues: ApplicationDefinitionIssue[],
): PortDescriptor => {
  const existing = current.operations[effect.operationKey];
  if (existing !== undefined && existing.id !== effect.id) {
    issues.push(definitionIssue(
      "ADAPTER_PORT_MISMATCH",
      `Port ${effect.portId} uses key ${effect.operationKey} for both ${existing.id} and ${effect.id}`,
      effect.portId,
    ));
    return current;
  }
  if (existing !== undefined) return current;
  return Object.freeze({
    descriptorType: "port",
    id: current.id,
    operations: Object.freeze({
      ...current.operations,
      [effect.operationKey]: effect,
    }),
  });
};

const validateQueryRuntime = (
  operation: AnyOperationDescriptor,
  issues: ApplicationDefinitionIssue[],
): void => {
  if (operation.kind !== "query") return;
  for (const effect of Object.values(operation.effects)) {
    if (effect.kind === "write") {
      issues.push(definitionIssue(
        "QUERY_WRITE_EFFECT",
        `Query ${operation.id} declares write effect ${effect.id}`,
        operation.id,
      ));
    }
  }
  if (Object.keys(operation.emits).length > 0) {
    issues.push(definitionIssue(
      "QUERY_EMITS_EVENT",
      `Query ${operation.id} declares emitted events`,
      operation.id,
    ));
  }
};

const recordId = (
  ids: Map<string, { readonly kind: string; readonly descriptor: object }>,
  issues: ApplicationDefinitionIssue[],
  id: string,
  kind: string,
  descriptor: object,
  allowSameReference = false,
): void => {
  const prior = ids.get(id);
  if (prior === undefined) {
    ids.set(id, { kind, descriptor });
  } else if (!(allowSameReference && prior.descriptor === descriptor)) {
    issues.push(definitionIssue(
      "DUPLICATE_ID",
      `Stable id ${id} is used by both ${prior.kind} and ${kind}`,
      id,
    ));
  }
};

const definitionIssue = (
  code: ApplicationDefinitionIssueCode,
  message: string,
  id?: string,
): ApplicationDefinitionIssue => Object.freeze(
  id === undefined ? { code, message } : { code, message, id },
);

const fault = (
  code: DispatchFaultCode,
  message: string,
  extras: Omit<DispatchFaultError, "code" | "message"> = {},
): DispatchFaultError => Object.freeze({ code, message, ...extras });

class BoundaryFault extends Error {
  readonly fault: DispatchFaultError;

  constructor(boundary: DispatchFaultError) {
    super(boundary.message);
    this.name = "BoundaryFault";
    this.fault = boundary;
  }
}

const latchBoundaryFault = (
  lifecycle: ExecutionLifecycle,
  boundary: DispatchFaultError,
): BoundaryFault => {
  lifecycle.boundaryFault ??= boundary;
  return new BoundaryFault(boundary);
};

const drainPendingEffects = async (
  lifecycle: ExecutionLifecycle,
): Promise<void> => {
  while (lifecycle.pendingEffects.size > 0) {
    await Promise.allSettled([...lifecycle.pendingEffects]);
  }
};

const effectFaultTrace = (
  operationId: string,
  alias: string,
  effectId: string,
  input: unknown,
  error: DispatchFaultError,
): EffectTraceEntry => Object.freeze({
  type: "effect",
  operationId,
  alias,
  effectId,
  input,
  status: "fault",
  error,
});

const includeTrace = <T extends object>(
  result: T,
  enabled: boolean,
  trace: TraceEntry[],
): T & { readonly trace?: ExecutionTrace } => Object.freeze(
  enabled
    ? { ...result, trace: Object.freeze([...trace]) }
    : result,
);

// These references make public descriptor relationships explicit to declaration tools.
export type ApplicationEventDescriptor = EventDescriptor;
export type ApplicationInvariantDescriptor = InvariantDescriptor;
export type ApplicationOperationDescriptor = OperationDescriptor;
