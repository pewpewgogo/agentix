import {
  FAIL_RESULT,
  type AnyBoundOperation,
  type AnyFeature,
  type AnyPortOperation,
  type BoundPortAdapter,
  type DeclaredError,
  type EventDescriptor,
  type FeatureDescriptor,
  type OperationEnsure,
  type OperationFailure,
} from "./descriptors.js";
import type { Outcome } from "./outcome.js";
import type { Infer, Schema, SchemaIssue } from "./schema.js";

export type RuntimeMode = "production" | "development" | "test";

export interface Principal {
  readonly id: string;
  readonly permissions: readonly string[] | ReadonlySet<string>;
}

export const principal = (
  id: string,
  permissions: readonly string[],
): Principal => Object.freeze({ id, permissions: Object.freeze([...permissions]) });

/* ------------------------------------------------------------------ */
/* Authorization: the single permission gate (also used by adapters)  */
/* ------------------------------------------------------------------ */

/**
 * Default permission-subset check. Operations without permissions accept
 * anonymous dispatches (amendment A2). HTTP adapters call this BEFORE
 * reading a request body.
 */
export const authorize = (
  operation: { readonly permissions?: readonly string[] },
  principal?: Principal,
): boolean => {
  const required = operation.permissions;
  if (required === undefined || required.length === 0) return true;
  if (principal === undefined) return false;
  const granted = toPermissionSet(principal.permissions);
  for (const permission of required) {
    if (!granted.has(permission)) return false;
  }
  return true;
};

const toPermissionSet = (
  permissions: readonly string[] | ReadonlySet<string>,
): ReadonlySet<string> =>
  permissions instanceof Set ? permissions : new Set(permissions);

const missingPermissionsOf = (
  operation: { readonly permissions: readonly string[] },
  principal?: Principal,
): readonly string[] => {
  if (operation.permissions.length === 0) return [];
  if (principal === undefined) return operation.permissions;
  const granted = toPermissionSet(principal.permissions);
  return operation.permissions.filter((permission) => !granted.has(permission));
};

/* ------------------------------------------------------------------ */
/* Dispatch result model (3-way semantics, unchanged)                 */
/* ------------------------------------------------------------------ */

export interface EffectTraceEntry {
  readonly type: "effect";
  readonly operationId: string;
  readonly alias: string;
  readonly effectId: string;
  readonly input: unknown;
  readonly status: "completed" | "fault";
  readonly value?: unknown;
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
  readonly principalId?: string;
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
  | "AUTHORIZE_FAILED"
  | "INPUT_VALIDATION_FAILED"
  | "INVALID_OUTPUT"
  | "INVALID_DOMAIN_ERROR"
  | "INVALID_EFFECT_INPUT"
  | "INVALID_EFFECT_OUTPUT"
  | "EFFECT_FAILURE"
  | "INVALID_EVENT_PAYLOAD"
  | "EVENT_OUTSIDE_EXECUTION"
  | "EFFECT_OUTSIDE_EXECUTION"
  | "OPERATION_DESCRIPTOR_MISMATCH"
  | "INVARIANT_VIOLATION"
  | "EXECUTION_FAILED";

export interface DispatchFaultError {
  readonly code: DispatchFaultCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly issues?: readonly SchemaIssue[];
  readonly effectId?: string;
  readonly eventId?: string;
  readonly invariant?: string;
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
  readonly principal?: Principal;
  /** Opt-in per dispatch; no trace machinery runs when off. */
  readonly trace?: boolean;
}

export interface CallOptions {
  readonly principal?: Principal;
}

/** Thrown by app.call() when a dispatch is rejected or faults. */
export class DispatchError extends Error {
  readonly kind: "rejected" | "fault";
  readonly code: string;
  readonly operationId: string | undefined;
  readonly detail: DispatchRejectionError | DispatchFaultError;

  constructor(result: RejectedDispatch | FaultedDispatch) {
    super(`Dispatch ${result.kind}: ${result.error.code}`);
    this.name = "DispatchError";
    this.kind = result.kind;
    this.code = result.error.code;
    this.operationId = result.operationId;
    this.detail = result.error;
  }
}

/* ------------------------------------------------------------------ */
/* Application typing (verified generic patterns)                     */
/* ------------------------------------------------------------------ */

export type OpInput<Op> = Op extends AnyBoundOperation ? Infer<Op["input"]> : never;
export type OpOutput<Op> = Op extends AnyBoundOperation ? Infer<Op["output"]> : never;
export type OpError<Op> = Op extends AnyBoundOperation
  ? DeclaredError<Op["errors"]>
  : never;

export type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

export type OperationsRecordOf<F> =
  F extends FeatureDescriptor<infer Id, infer Ops>
    ? { [K in keyof Ops & string as `${Id}.${K}`]: Ops[K] }
    : never;

export type ApplicationOperations<Features extends readonly AnyFeature[]> =
  UnionToIntersection<OperationsRecordOf<Features[number]>>;

export interface Application<Ops> {
  readonly mode: RuntimeMode;
  readonly features: readonly AnyFeature[];
  /** Operations keyed by derived id, e.g. "notes.create". */
  readonly operations: Ops;
  getOperation(id: string): AnyBoundOperation | undefined;
  /**
   * The EFFECTIVE permission gate: the custom `authorize` hook when one was
   * provided to createApplication, else the exported default subset check.
   * HTTP adapters call this for the pre-body 403 so custom hooks are honored
   * on every entry. May throw if a custom hook throws; dispatch converts such
   * throws into an AUTHORIZE_FAILED fault.
   */
  authorize(operation: AnyBoundOperation, principal?: Principal): boolean;
  dispatch<Id extends keyof Ops & string>(
    operationId: Id,
    options: DispatchOptions<OpInput<Ops[Id]>>,
  ): Promise<DispatchResult<OpOutput<Ops[Id]>, OpError<Ops[Id]>>>;
  dispatch<Operation extends AnyBoundOperation>(
    operation: Operation,
    options: DispatchOptions<Infer<Operation["input"]>>,
  ): Promise<DispatchResult<Infer<Operation["output"]>, DeclaredError<Operation["errors"]>>>;
  /** Sugar over dispatch: returns the Outcome, throws DispatchError otherwise. */
  call<Id extends keyof Ops & string>(
    operationId: Id,
    input: OpInput<Ops[Id]>,
    options?: CallOptions,
  ): Promise<Outcome<OpOutput<Ops[Id]>, OpError<Ops[Id]>>>;
}

export interface ApplicationDefinition<Features extends readonly AnyFeature[]> {
  readonly features: Features;
  readonly adapters?: readonly BoundPortAdapter[];
  /** Defaults from NODE_ENV (amendment A6). */
  readonly mode?: RuntimeMode;
  /** Optional custom hook; default is the permission-subset authorize(). */
  readonly authorize?: (
    principal: Principal | undefined,
    operation: AnyBoundOperation,
  ) => boolean;
}

export type ApplicationDefinitionIssueCode =
  | "DUPLICATE_ID"
  | "DUPLICATE_ADAPTER"
  | "MISSING_ADAPTER"
  | "INCOMPLETE_ADAPTER"
  | "QUERY_WRITE_EFFECT"
  | "QUERY_EMITS_EVENT"
  | "HTTP_ROUTE_CONFLICT";

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

/* ------------------------------------------------------------------ */
/* Runtime                                                            */
/* ------------------------------------------------------------------ */

interface ExecutionLifecycle {
  active: boolean;
  boundaryFault: DispatchFaultError | undefined;
  readonly pendingEffects: Set<Promise<unknown>>;
  readonly events: EmittedEvent[];
}

interface CompiledEffect {
  readonly alias: string;
  readonly effect: AnyPortOperation;
  readonly handler: (input: unknown) => unknown;
}

interface CompiledEmit {
  readonly alias: string;
  readonly event: EventDescriptor;
}

interface CompiledEnsure {
  readonly name: string;
  readonly ensure: OperationEnsure;
}

interface CompiledOperation {
  readonly operation: AnyBoundOperation;
  readonly effects: readonly CompiledEffect[];
  readonly emits: readonly CompiledEmit[];
  readonly ensures: readonly CompiledEnsure[];
  readonly errorDetails: Readonly<Record<string, Schema<unknown>>>;
}

const EMPTY_RECORD: Readonly<Record<string, never>> = Object.freeze({});
const EMPTY_EVENTS: readonly EmittedEvent[] = Object.freeze([]);

const detectMode = (): RuntimeMode => {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.["NODE_ENV"];
  return env === "production" || env === "test" ? env : "development";
};

export const createApplication = <const Features extends readonly AnyFeature[]>(
  definition: ApplicationDefinition<Features>,
): Application<ApplicationOperations<Features>> => {
  const issues: ApplicationDefinitionIssue[] = [];
  const features = Object.freeze([...definition.features]);
  const mode = definition.mode ?? detectMode();
  const devChecks = mode !== "production";
  const authorizeHook = definition.authorize;

  /** Effective gate: custom hook when provided, else the default subset check. */
  const effectiveAuthorize = (
    operation: AnyBoundOperation,
    principal?: Principal,
  ): boolean =>
    authorizeHook === undefined
      ? authorize(operation, principal)
      : authorizeHook(principal, operation);

  /* ---------------- startup validation ---------------- */

  const allIds = new Map<string, { readonly kind: string; readonly descriptor: object }>();
  const operationsById = new Map<string, AnyBoundOperation>();
  const requiredEffects: AnyPortOperation[] = [];
  const routes = new Map<string, string>();

  for (const feature of features) {
    recordId(allIds, issues, feature.id, "feature", feature);
    for (const key of Object.keys(feature.operations)) {
      const operation = feature.operations[key];
      if (operation === undefined) continue;
      recordId(allIds, issues, operation.id, `${operation.kind} operation`, operation);
      if (!operationsById.has(operation.id)) {
        operationsById.set(operation.id, operation);
      }

      if (operation.kind === "query") {
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
      }

      for (const effect of Object.values(operation.effects)) {
        recordId(allIds, issues, effect.id, "port operation", effect, true);
        requiredEffects.push(effect);
      }
      for (const emitted of Object.values(operation.emits)) {
        recordId(allIds, issues, emitted.id, "event", emitted, true);
      }

      if (operation.http !== undefined) {
        const routeKey = `${operation.http.method} ${operation.http.path}`;
        const existing = routes.get(routeKey);
        if (existing !== undefined) {
          issues.push(definitionIssue(
            "HTTP_ROUTE_CONFLICT",
            `Operations ${existing} and ${operation.id} both declare ${routeKey}`,
            operation.id,
          ));
        } else {
          routes.set(routeKey, operation.id);
        }
      }
    }
    for (const emitted of feature.events) {
      recordId(allIds, issues, emitted.id, "event", emitted, true);
    }
  }

  const adaptersByPort = new Map<string, BoundPortAdapter>();
  for (const adapter of definition.adapters ?? []) {
    if (adaptersByPort.has(adapter.portId)) {
      issues.push(definitionIssue(
        "DUPLICATE_ADAPTER",
        `Port ${adapter.portId} has more than one adapter`,
        adapter.portId,
      ));
    } else {
      adaptersByPort.set(adapter.portId, adapter);
    }
  }

  const missingPorts = new Set<string>();
  for (const effect of requiredEffects) {
    const adapter = adaptersByPort.get(effect.portId);
    if (adapter === undefined) {
      if (!missingPorts.has(effect.portId)) {
        missingPorts.add(effect.portId);
        issues.push(definitionIssue(
          "MISSING_ADAPTER",
          `No adapter is bound for required port ${effect.portId}`,
          effect.portId,
        ));
      }
      continue;
    }
    if (typeof adapter.operations[effect.opKey] !== "function") {
      issues.push(definitionIssue(
        "INCOMPLETE_ADAPTER",
        `Adapter for ${effect.portId} does not implement ${effect.id}`,
        effect.id,
      ));
    }
  }

  if (issues.length > 0) throw new ApplicationDefinitionError(issues);

  /* ---------------- precomputed per-operation fast path ---------------- */

  const compiledById = new Map<string, CompiledOperation>();
  const operationsRecord: Record<string, AnyBoundOperation> = {};
  for (const operation of operationsById.values()) {
    operationsRecord[operation.id] = operation;
    const effects: CompiledEffect[] = [];
    for (const alias of Object.keys(operation.effects)) {
      const effect = operation.effects[alias];
      if (effect === undefined) continue;
      const adapter = adaptersByPort.get(effect.portId);
      const handler = adapter?.operations[effect.opKey];
      if (typeof handler !== "function") continue; // validated above; defensive
      effects.push({ alias, effect, handler: handler as (input: unknown) => unknown });
    }
    const emits: CompiledEmit[] = [];
    for (const alias of Object.keys(operation.emits)) {
      const emitted = operation.emits[alias];
      if (emitted === undefined) continue;
      emits.push({ alias, event: emitted });
    }
    const ensures: CompiledEnsure[] = [];
    for (const name of Object.keys(operation.ensures)) {
      const ensure = operation.ensures[name];
      if (ensure === undefined) continue;
      ensures.push({ name, ensure });
    }
    compiledById.set(operation.id, {
      operation,
      effects,
      emits,
      ensures,
      errorDetails: operation.errorDetails,
    });
  }

  /* ---------------- per-dispatch machinery ---------------- */

  const maybeFreeze = <T extends object>(value: T): T =>
    devChecks ? Object.freeze(value) : value;

  const finalize = <T extends object>(
    result: T,
    trace: TraceEntry[] | null,
  ): T & { readonly trace?: ExecutionTrace } => {
    const value =
      trace === null ? result : { ...result, trace: maybeFreeze(trace) };
    return maybeFreeze(value);
  };

  const makeEffectFunction = (
    operation: AnyBoundOperation,
    binding: CompiledEffect,
    lifecycle: ExecutionLifecycle,
    trace: TraceEntry[] | null,
  ): ((input: unknown) => Promise<unknown>) => {
    const { alias, effect, handler } = binding;
    const run = async (input: unknown): Promise<unknown> => {
      if (!lifecycle.active) {
        throw latchBoundaryFault(lifecycle, fault(
          "EFFECT_OUTSIDE_EXECUTION",
          `Effect ${effect.id} was invoked outside ${operation.id} execution`,
          { effectId: effect.id },
        ));
      }

      let parsedInput: unknown;
      try {
        const parsed = effect.input.safeParse(input);
        if (!parsed.success) {
          const boundary = fault(
            "INVALID_EFFECT_INPUT",
            `Invalid input for effect ${effect.id}`,
            { effectId: effect.id, issues: parsed.issues },
          );
          trace?.push(effectFaultEntry(operation.id, alias, effect.id, input, boundary));
          throw latchBoundaryFault(lifecycle, boundary);
        }
        parsedInput = parsed.data;
      } catch (cause) {
        if (cause instanceof BoundaryFault) throw cause;
        const boundary = fault(
          "INVALID_EFFECT_INPUT",
          `Input schema for effect ${effect.id} threw during validation`,
          { effectId: effect.id, cause },
        );
        trace?.push(effectFaultEntry(operation.id, alias, effect.id, input, boundary));
        throw latchBoundaryFault(lifecycle, boundary);
      }

      let value: unknown;
      try {
        value = await handler(parsedInput);
      } catch (cause) {
        const boundary = fault(
          "EFFECT_FAILURE",
          `Adapter for ${effect.id} threw an unexpected exception`,
          { effectId: effect.id, cause },
        );
        trace?.push(effectFaultEntry(operation.id, alias, effect.id, parsedInput, boundary));
        throw latchBoundaryFault(lifecycle, boundary);
      }

      // Effect outputs are re-parsed in EVERY mode, production included:
      // execute always receives the DETACHED parse product, never the
      // adapter's live object, so mutations cannot alias store state.
      // (Orchestrator amendment overriding SPEC section 1's production-skip
      // bullet: uniform data semantics beats the ~0.16us saving.)
      try {
        const parsedOutput = effect.output.safeParse(value);
        if (!parsedOutput.success) {
          const boundary = fault(
            "INVALID_EFFECT_OUTPUT",
            `Adapter for ${effect.id} returned invalid output`,
            { effectId: effect.id, issues: parsedOutput.issues },
          );
          trace?.push(effectFaultEntry(operation.id, alias, effect.id, parsedInput, boundary));
          throw latchBoundaryFault(lifecycle, boundary);
        }
        value = parsedOutput.data;
      } catch (cause) {
        if (cause instanceof BoundaryFault) throw cause;
        const boundary = fault(
          "INVALID_EFFECT_OUTPUT",
          `Output schema for effect ${effect.id} threw during validation`,
          { effectId: effect.id, cause },
        );
        trace?.push(effectFaultEntry(operation.id, alias, effect.id, parsedInput, boundary));
        throw latchBoundaryFault(lifecycle, boundary);
      }

      trace?.push({
        type: "effect",
        operationId: operation.id,
        alias,
        effectId: effect.id,
        input: parsedInput,
        status: "completed",
        value,
      });
      return value;
    };

    return (input: unknown): Promise<unknown> => {
      const pending = run(input);
      lifecycle.pendingEffects.add(pending);
      const remove = (): void => {
        lifecycle.pendingEffects.delete(pending);
      };
      void pending.then(remove, remove);
      return pending;
    };
  };

  const buildEffectsContext = (
    compiled: CompiledOperation,
    lifecycle: ExecutionLifecycle,
    trace: TraceEntry[] | null,
  ): Record<string, (input: unknown) => Promise<unknown>> => {
    if (compiled.effects.length === 0) {
      return EMPTY_RECORD as Record<string, (input: unknown) => Promise<unknown>>;
    }
    const context: Record<string, (input: unknown) => Promise<unknown>> = {};
    for (const binding of compiled.effects) {
      context[binding.alias] = makeEffectFunction(
        compiled.operation,
        binding,
        lifecycle,
        trace,
      );
    }
    return devChecks ? Object.freeze(context) : context;
  };

  const buildEmitContext = (
    compiled: CompiledOperation,
    lifecycle: ExecutionLifecycle,
    trace: TraceEntry[] | null,
  ): Record<string, (payload: unknown) => void> => {
    if (compiled.emits.length === 0) {
      return EMPTY_RECORD as Record<string, (payload: unknown) => void>;
    }
    const operation = compiled.operation;
    const emitter: Record<string, (payload: unknown) => void> = {};
    for (const { alias, event } of compiled.emits) {
      emitter[alias] = (payload: unknown): void => {
        if (!lifecycle.active) {
          throw latchBoundaryFault(lifecycle, fault(
            "EVENT_OUTSIDE_EXECUTION",
            `Event ${event.id} was emitted outside ${operation.id} execution`,
            { eventId: event.id },
          ));
        }
        let eventPayload: unknown;
        try {
          const parsed = event.payload.safeParse(payload);
          if (!parsed.success) {
            throw new BoundaryFault(fault(
              "INVALID_EVENT_PAYLOAD",
              `Invalid payload for event ${event.id}`,
              { eventId: event.id, issues: parsed.issues },
            ));
          }
          // Built-in schema parse products are already detached graphs, so in
          // production the second copy-walk is skipped when the parse detached
          // the payload (parsed.data !== payload). Pass-through custom schemas
          // (parsed.data === payload) are still snapshotted in every mode, and
          // dev/test always snapshots + deep-freezes.
          eventPayload =
            !devChecks && parsed.data !== payload
              ? parsed.data
              : snapshotStructuredValue(parsed.data, devChecks);
        } catch (cause) {
          const boundary = cause instanceof BoundaryFault
            ? cause.fault
            : fault(
                "INVALID_EVENT_PAYLOAD",
                `Could not validate or snapshot payload for event ${event.id}`,
                { eventId: event.id, cause },
              );
          throw latchBoundaryFault(lifecycle, boundary);
        }
        const emitted: EmittedEvent = maybeFreeze({
          operationId: operation.id,
          alias,
          eventId: event.id,
          version: event.version,
          payload: eventPayload,
        });
        lifecycle.events.push(emitted);
        trace?.push({ type: "event", ...emitted });
      };
    }
    return devChecks ? Object.freeze(emitter) : emitter;
  };

  /* ---------------- dispatch ---------------- */

  const dispatch = async (
    requested: AnyBoundOperation | string,
    options: DispatchOptions<unknown>,
  ): Promise<DispatchResult<unknown, unknown>> => {
    const requestedId = typeof requested === "string" ? requested : requested.id;
    const compiled = compiledById.get(requestedId);
    const trace: TraceEntry[] | null = options.trace === true ? [] : null;

    if (compiled === undefined) {
      return finalize(
        {
          kind: "rejected" as const,
          operationId: requestedId,
          error: maybeFreeze({
            code: "UNKNOWN_OPERATION" as const,
            operationId: requestedId,
          }),
        },
        trace,
      );
    }
    const operation = compiled.operation;

    if (typeof requested !== "string" && requested !== operation) {
      return finalize(
        {
          kind: "fault" as const,
          operationId: requestedId,
          error: fault(
            "OPERATION_DESCRIPTOR_MISMATCH",
            `Operation descriptor ${requestedId} is not the registered application descriptor`,
          ),
        },
        trace,
      );
    }

    // Authorization deliberately precedes input parsing and context construction.
    // A throwing custom hook is a fault, never a rejected dispatch promise.
    let allowed: boolean;
    try {
      allowed = effectiveAuthorize(operation, options.principal);
    } catch (cause) {
      return finalize(
        {
          kind: "fault" as const,
          operationId: operation.id,
          error: fault(
            "AUTHORIZE_FAILED",
            `Authorization hook threw for operation ${operation.id}`,
            { cause },
          ),
        },
        trace,
      );
    }
    if (!allowed) {
      return finalize(
        {
          kind: "rejected" as const,
          operationId: operation.id,
          error: maybeFreeze({
            code: "PERMISSION_DENIED" as const,
            ...(options.principal === undefined
              ? {}
              : { principalId: options.principal.id }),
            missingPermissions: missingPermissionsOf(operation, options.principal),
          }),
        },
        trace,
      );
    }

    let inputData: unknown;
    try {
      const parsedInput = operation.input.safeParse(options.input);
      if (!parsedInput.success) {
        return finalize(
          {
            kind: "rejected" as const,
            operationId: operation.id,
            error: maybeFreeze({
              code: "INVALID_INPUT" as const,
              issues: parsedInput.issues,
            }),
          },
          trace,
        );
      }
      inputData = parsedInput.data;
    } catch (cause) {
      return finalize(
        {
          kind: "fault" as const,
          operationId: operation.id,
          error: fault(
            "INPUT_VALIDATION_FAILED",
            `Input schema for operation ${operation.id} threw during validation`,
            { cause },
          ),
        },
        trace,
      );
    }

    const lifecycle: ExecutionLifecycle = {
      active: true,
      boundaryFault: undefined,
      pendingEffects: new Set(),
      events: [],
    };
    const context = {
      input: inputData,
      effects: buildEffectsContext(compiled, lifecycle, trace),
      emit: buildEmitContext(compiled, lifecycle, trace),
      fail: operation.fail,
    };
    if (devChecks) Object.freeze(context);

    let raw: unknown;
    try {
      raw = await (operation.execute as (context: unknown) => unknown)(context);
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
      return finalize({ kind: "fault" as const, operationId: operation.id, error }, trace);
    }
    lifecycle.active = false;
    await drainPendingEffects(lifecycle);
    if (lifecycle.boundaryFault !== undefined) {
      return finalize(
        { kind: "fault" as const, operationId: operation.id, error: lifecycle.boundaryFault },
        trace,
      );
    }

    // External boundaries stay validated in ALL modes (incl. production):
    // operation output parse and declared-error details parse.
    let failure: { readonly code: unknown; readonly details: unknown } | undefined;
    try {
      // Hostile values (throwing `has` traps or getters) must fault, not throw.
      failure = isFailResult(raw)
        ? { code: raw.error.code, details: raw.error.details }
        : undefined;
    } catch (cause) {
      return finalize(
        {
          kind: "fault" as const,
          operationId: operation.id,
          error: fault(
            "INVALID_OUTPUT",
            `Operation ${operation.id} returned a value that could not be inspected`,
            { cause },
          ),
        },
        trace,
      );
    }
    let outcome: Outcome<unknown, unknown>;
    if (failure !== undefined) {
      const code = failure.code;
      const detailsSchema =
        typeof code === "string" ? compiled.errorDetails[code] : undefined;
      if (detailsSchema === undefined) {
        return finalize(
          {
            kind: "fault" as const,
            operationId: operation.id,
            error: fault(
              "INVALID_DOMAIN_ERROR",
              `Operation ${operation.id} failed with undeclared error code ${String(code)}`,
            ),
          },
          trace,
        );
      }
      let parsedDetails: unknown;
      try {
        const parsed = detailsSchema.safeParse(failure.details);
        if (!parsed.success) {
          return finalize(
            {
              kind: "fault" as const,
              operationId: operation.id,
              error: fault(
                "INVALID_DOMAIN_ERROR",
                `Operation ${operation.id} returned invalid details for error ${code}`,
                { issues: parsed.issues },
              ),
            },
            trace,
          );
        }
        parsedDetails = parsed.data;
      } catch (cause) {
        return finalize(
          {
            kind: "fault" as const,
            operationId: operation.id,
            error: fault(
              "INVALID_DOMAIN_ERROR",
              `Details schema for error ${code} threw during validation`,
              { cause },
            ),
          },
          trace,
        );
      }
      outcome = maybeFreeze({
        ok: false as const,
        error: maybeFreeze({ code, details: parsedDetails }),
      });
    } else {
      try {
        const parsedOutput = operation.output.safeParse(raw);
        if (!parsedOutput.success) {
          return finalize(
            {
              kind: "fault" as const,
              operationId: operation.id,
              error: fault(
                "INVALID_OUTPUT",
                `Operation ${operation.id} returned invalid output`,
                { issues: parsedOutput.issues },
              ),
            },
            trace,
          );
        }
        outcome = maybeFreeze({ ok: true as const, value: parsedOutput.data });
      } catch (cause) {
        return finalize(
          {
            kind: "fault" as const,
            operationId: operation.id,
            error: fault(
              "INVALID_OUTPUT",
              `Output schema for operation ${operation.id} threw during validation`,
              { cause },
            ),
          },
          trace,
        );
      }
    }

    // Invariants run post-completion in dev/test only.
    if (devChecks && outcome.ok && compiled.ensures.length > 0) {
      for (const { name, ensure } of compiled.ensures) {
        let passed: boolean;
        try {
          passed = ensure.check({ input: inputData, output: outcome.value });
        } catch (cause) {
          return finalize(
            {
              kind: "fault" as const,
              operationId: operation.id,
              error: fault(
                "INVARIANT_VIOLATION",
                `Invariant ${name} threw for ${operation.id}`,
                { invariant: name, cause },
              ),
            },
            trace,
          );
        }
        if (!passed) {
          return finalize(
            {
              kind: "fault" as const,
              operationId: operation.id,
              error: fault(
                "INVARIANT_VIOLATION",
                `Invariant ${name} violated by ${operation.id}`,
                { invariant: name },
              ),
            },
            trace,
          );
        }
      }
    }

    const events = lifecycle.events.length === 0
      ? EMPTY_EVENTS
      : (maybeFreeze(lifecycle.events) as readonly EmittedEvent[]);
    return finalize(
      { kind: "completed" as const, operationId: operation.id, outcome, events },
      trace,
    );
  };

  const call = async (
    operationId: string,
    input: unknown,
    options?: CallOptions,
  ): Promise<Outcome<unknown, unknown>> => {
    const result = await dispatch(operationId, {
      input,
      ...(options?.principal === undefined ? {} : { principal: options.principal }),
    });
    if (result.kind === "completed") return result.outcome;
    throw new DispatchError(result);
  };

  return Object.freeze({
    mode,
    features,
    operations: Object.freeze(operationsRecord),
    getOperation(id: string): AnyBoundOperation | undefined {
      return operationsById.get(id);
    },
    authorize: effectiveAuthorize,
    dispatch,
    call,
  }) as unknown as Application<ApplicationOperations<Features>>;
};

/* ------------------------------------------------------------------ */
/* Internals                                                          */
/* ------------------------------------------------------------------ */

const isFailResult = (
  value: unknown,
): value is OperationFailure<{ readonly code: unknown; readonly details: unknown }> =>
  typeof value === "object" && value !== null && FAIL_RESULT in value;

/**
 * Detach the structured values produced by built-in schemas (always) and
 * deep-freeze them (dev/test only). The iterative walk preserves cycles and
 * shared references without unbounded recursion.
 */
const snapshotStructuredValue = (value: unknown, freeze: boolean): unknown => {
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

  if (freeze) {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      const container = created[index];
      if (container !== undefined) Object.freeze(container);
    }
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
    : (Object.create(Object.getPrototypeOf(source) as object | null) as object);

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
): ApplicationDefinitionIssue =>
  Object.freeze(id === undefined ? { code, message } : { code, message, id });

const fault = (
  code: DispatchFaultCode,
  message: string,
  extras: Omit<DispatchFaultError, "code" | "message"> = {},
): DispatchFaultError => ({ code, message, ...extras });

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

const drainPendingEffects = async (lifecycle: ExecutionLifecycle): Promise<void> => {
  while (lifecycle.pendingEffects.size > 0) {
    await Promise.allSettled([...lifecycle.pendingEffects]);
  }
};

const effectFaultEntry = (
  operationId: string,
  alias: string,
  effectId: string,
  input: unknown,
  error: DispatchFaultError,
): EffectTraceEntry => ({
  type: "effect",
  operationId,
  alias,
  effectId,
  input,
  status: "fault",
  error,
});
