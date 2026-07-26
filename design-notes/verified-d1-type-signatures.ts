/**
 * Probe 1 (v2): D1 single-file feature authoring type feasibility.
 * Fixes over v1:
 *  - descriptor stores http.errorStatus loosely (Record<string, number>);
 *    the `keyof Errors` check lives ONLY in the command()/query() parameter
 *    type, so Errors stays covariant on the descriptor interface.
 *  - Port.adapter() returns a NON-generic BoundPortAdapter so Ops stays
 *    covariant on PortDescriptor.
 *  - Application's Ops type param is unconstrained; helper conditionals
 *    extract input/output/errors.
 */

/* ------------------------------------------------------------------ */
/* Minimal schema stub (mirrors packages/core/src/schema.ts)          */
/* ------------------------------------------------------------------ */

interface Schema<T> {
  readonly kind: string;
  parse(value: unknown): T;
}
type Infer<S extends Schema<unknown>> = S extends Schema<infer T> ? T : never;

// AMENDMENT under test: object() must return ObjectSchema exposing typed shape
interface ObjectSchema<S extends Record<string, Schema<unknown>>>
  extends Schema<{ [K in keyof S]: Infer<S[K]> }> {
  readonly shape: S;
}

declare const s: {
  string(options?: { min?: number; max?: number }): Schema<string>;
  id<const Brand extends string>(brand: Brand): Schema<string & { __brand: Brand }>;
  optional<S extends Schema<unknown>>(inner: S): Schema<Infer<S> | undefined>;
  object<const S extends Record<string, Schema<unknown>>>(shape: S): ObjectSchema<S>;
};

/* ------------------------------------------------------------------ */
/* Outcome / errors                                                   */
/* ------------------------------------------------------------------ */

type MaybePromise<T> = T | Promise<T>;
type Outcome<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
declare const ok: <T>(value: T) => Outcome<T, never>;
declare const err: <const C extends string, D>(
  code: C,
  details: D,
) => Outcome<never, { readonly code: C; readonly details: D }>;

type ErrorSchemaMap = Readonly<Record<string, Schema<unknown>>>;
type DeclaredError<Errors extends ErrorSchemaMap> = {
  [Code in keyof Errors & string]: Readonly<{ code: Code; details: Infer<Errors[Code]> }>;
}[keyof Errors & string];

/* ------------------------------------------------------------------ */
/* Ports: port(id, { key: port.write({...}) }) with derived op ids    */
/* ------------------------------------------------------------------ */

type EffectKind = "read" | "write" | "time" | "random" | "external";

interface UnboundPortOperation<
  Kind extends EffectKind = EffectKind,
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
> {
  readonly descriptorType: "port-operation";
  readonly kind: Kind;
  readonly input: Input;
  readonly output: Output;
  readonly errors: Errors;
}

interface PortOperationDescriptor<
  Id extends string = string,
  Kind extends EffectKind = EffectKind,
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
> extends UnboundPortOperation<Kind, Input, Output, Errors> {
  readonly id: Id;
}

type AnyPortOperation = PortOperationDescriptor;

type BoundPortOperations<PortId extends string, Ops> = {
  readonly [K in keyof Ops & string]: Ops[K] extends UnboundPortOperation<
    infer Kind,
    infer Input,
    infer Output,
    infer Errors
  >
    ? PortOperationDescriptor<`${PortId}.${K}`, Kind, Input, Output, Errors>
    : never;
};

type EffectHandler<Operation extends AnyPortOperation> = (
  input: Infer<Operation["input"]>,
) => MaybePromise<Outcome<Infer<Operation["output"]>, DeclaredError<Operation["errors"]>>>;

// The conditional guard is load-bearing: it is what keeps specific
// instantiations assignable to the Any* top types (repo-proven pattern).
type PortImplementation<Ops extends Record<string, AnyPortOperation>> = {
  readonly [K in keyof Ops]: Ops[K] extends AnyPortOperation ? EffectHandler<Ops[K]> : never;
};

// Non-generic on purpose: keeps PortDescriptor.Ops covariant. The runtime
// carries the specific handlers; the type system treats them opaquely.
interface BoundPortAdapter {
  readonly descriptorType: "port-adapter";
  readonly portId: string;
  readonly operations: Readonly<
    Record<string, (input: never) => MaybePromise<Outcome<unknown, unknown>>>
  >;
}

interface PortDescriptor<
  Id extends string = string,
  Ops extends Record<string, AnyPortOperation> = Record<string, AnyPortOperation>,
> {
  readonly descriptorType: "port";
  readonly id: Id;
  readonly operations: Ops;
  adapter(implementation: PortImplementation<Ops>): BoundPortAdapter;
}

interface PortOperationFactory<Kind extends EffectKind> {
  <
    Input extends Schema<unknown>,
    Output extends Schema<unknown>,
    const Errors extends ErrorSchemaMap = Record<never, never>,
  >(definition: {
    readonly input: Input;
    readonly output: Output;
    readonly errors?: Errors;
  }): UnboundPortOperation<Kind, Input, Output, Errors>;
}

// Validation intersection: rejects non-port-op properties at the call site
// WITHOUT giving the argument a concrete contextual type (which would poison
// inner generic defaults — see probe4/probe5).
type ValidPortOps<Ops> = {
  readonly [K in keyof Ops]: Ops[K] extends UnboundPortOperation ? Ops[K] : UnboundPortOperation;
};

interface PortFactory {
  <const Id extends string, const Ops extends Readonly<Record<string, unknown>>>(
    id: Id,
    operations: Ops & ValidPortOps<Ops>,
  ): PortDescriptor<Id, BoundPortOperations<Id, Ops>>;
  readonly read: PortOperationFactory<"read">;
  readonly write: PortOperationFactory<"write">;
  readonly time: PortOperationFactory<"time">;
  readonly random: PortOperationFactory<"random">;
  readonly external: PortOperationFactory<"external">;
}
declare const port: PortFactory;

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

interface EventDescriptor<
  Id extends string = string,
  Version extends number = number,
  Payload extends Schema<unknown> = Schema<unknown>,
> {
  readonly descriptorType: "event";
  readonly id: Id;
  readonly version: Version;
  readonly payload: Payload;
}
declare const event: <const Id extends string, const V extends number, P extends Schema<unknown>>(
  id: Id,
  version: V,
  payload: P,
) => EventDescriptor<Id, V, P>;

/* ------------------------------------------------------------------ */
/* Operations: command/query WITHOUT ids (unbound)                    */
/* ------------------------------------------------------------------ */

type EffectMap = Readonly<Record<string, AnyPortOperation>>;
type EventMap = Readonly<Record<string, EventDescriptor>>;

type EffectContext<Effects extends EffectMap> = {
  readonly [Name in keyof Effects]: Effects[Name] extends AnyPortOperation
    ? EffectHandler<Effects[Name]>
    : never;
};
type EventEmitter<Events extends EventMap> = {
  readonly [Name in keyof Events]: Events[Name] extends EventDescriptor<string, number, infer P>
    ? (payload: Infer<P>) => void
    : never;
};

interface ExecutionContext<
  Input extends Schema<unknown>,
  Effects extends EffectMap,
  Emits extends EventMap,
> {
  readonly input: Infer<Input>;
  readonly effects: EffectContext<Effects>;
  readonly emit: EventEmitter<Emits>;
}

// STORED on descriptors: variance-neutral (no keyof Errors here).
interface HttpMetadata {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly status?: number;
  readonly errorStatus?: Readonly<Record<string, number>>;
}

// AUTHORING-side check only: typo'd error codes rejected at the call site.
interface AuthoredHttp<Errors extends ErrorSchemaMap> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly status?: number;
  readonly errorStatus?: { readonly [Code in keyof Errors]?: number };
}

interface UnboundOperation<
  Kind extends "command" | "query" = "command" | "query",
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
  Effects extends EffectMap = EffectMap,
  Emits extends EventMap = EventMap,
> {
  readonly descriptorType: "unbound-operation";
  readonly kind: Kind;
  readonly input: Input;
  readonly output: Output;
  readonly errors: Errors;
  readonly permissions: readonly string[];
  readonly http?: HttpMetadata;
  readonly effects: Effects;
  readonly emits: Emits;
  // Method syntax on purpose: params are bivariant positions during variance
  // measurement, so Input/Effects/Emits stay covariant on this interface.
  execute(
    context: ExecutionContext<Input, Effects, Emits>,
  ): MaybePromise<Outcome<Infer<Output>, DeclaredError<Errors>>>;
}

type AnyUnboundOperation = UnboundOperation;

declare const command: <
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  const Errors extends ErrorSchemaMap = Record<never, never>,
  const Effects extends EffectMap = Record<never, never>,
  const Emits extends EventMap = Record<never, never>,
>(definition: {
  readonly input: Input;
  readonly output: Output;
  readonly errors?: Errors;
  readonly permissions?: readonly string[];
  readonly http?: AuthoredHttp<Errors>;
  readonly effects?: Effects;
  readonly emits?: Emits;
  readonly execute: (
    context: ExecutionContext<Input, Effects, Emits>,
  ) => MaybePromise<Outcome<Infer<Output>, DeclaredError<Errors>>>;
}) => UnboundOperation<"command", Input, Output, Errors, Effects, Emits>;

declare const query: <
  Input extends Schema<unknown>,
  Output extends Schema<unknown>,
  const Errors extends ErrorSchemaMap = Record<never, never>,
  const Effects extends EffectMap = Record<never, never>,
>(definition: {
  readonly input: Input;
  readonly output: Output;
  readonly errors?: Errors;
  readonly permissions?: readonly string[];
  readonly http?: AuthoredHttp<Errors>;
  readonly effects?: Effects;
  readonly execute: (
    context: ExecutionContext<Input, Effects, Record<never, never>>,
  ) => MaybePromise<Outcome<Infer<Output>, DeclaredError<Errors>>>;
}) => UnboundOperation<"query", Input, Output, Errors, Effects, Record<never, never>>;

/* ------------------------------------------------------------------ */
/* feature(id, { operations }) -> ids derived `${featureId}.${key}`   */
/* ------------------------------------------------------------------ */

interface BoundOperation<
  Id extends string = string,
  Kind extends "command" | "query" = "command" | "query",
  Input extends Schema<unknown> = Schema<unknown>,
  Output extends Schema<unknown> = Schema<unknown>,
  Errors extends ErrorSchemaMap = ErrorSchemaMap,
  Effects extends EffectMap = EffectMap,
  Emits extends EventMap = EventMap,
> extends UnboundOperation<Kind, Input, Output, Errors, Effects, Emits> {
  readonly id: Id;
}

type AnyBoundOperation = BoundOperation;

type BindOperations<FeatureId extends string, Ops> = {
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

interface FeatureDescriptor<
  Id extends string = string,
  Ops extends Record<string, AnyBoundOperation> = Record<string, AnyBoundOperation>,
> {
  readonly descriptorType: "feature";
  readonly id: Id;
  readonly operations: Ops;
  readonly ports: readonly PortDescriptor[];
}

type AnyFeature = FeatureDescriptor;

type ValidOperations<Ops> = {
  readonly [K in keyof Ops]: Ops[K] extends AnyUnboundOperation ? Ops[K] : AnyUnboundOperation;
};

declare const feature: <
  const Id extends string,
  const Ops extends Readonly<Record<string, unknown>>,
>(
  id: Id,
  definition: {
    readonly ports?: readonly PortDescriptor[];
    readonly operations: Ops & ValidOperations<Ops>;
  },
) => FeatureDescriptor<Id, BindOperations<Id, Ops>>;

/* ------------------------------------------------------------------ */
/* Application: dispatch("notes.create", {...}) typed by id           */
/* ------------------------------------------------------------------ */

interface Principal {
  readonly permissions: ReadonlySet<string>;
}

type DispatchResult<T, E> =
  | { readonly kind: "completed"; readonly outcome: Outcome<T, E> }
  | { readonly kind: "rejected" }
  | { readonly kind: "fault" };

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

type OperationsRecordOf<F> = F extends FeatureDescriptor<infer Id, infer Ops>
  ? { [K in keyof Ops & string as `${Id}.${K}`]: Ops[K] }
  : never;

type ApplicationOperations<Features extends readonly AnyFeature[]> = UnionToIntersection<
  OperationsRecordOf<Features[number]>
>;

type OpInput<Op> = Op extends AnyBoundOperation ? Infer<Op["input"]> : never;
type OpOutput<Op> = Op extends AnyBoundOperation ? Infer<Op["output"]> : never;
type OpError<Op> = Op extends AnyBoundOperation ? DeclaredError<Op["errors"]> : never;

interface Application<Ops> {
  readonly operations: Ops;
  dispatch<Id extends keyof Ops & string>(
    operationId: Id,
    options: { readonly input: OpInput<Ops[Id]>; readonly principal: Principal },
  ): Promise<DispatchResult<OpOutput<Ops[Id]>, OpError<Ops[Id]>>>;
}

declare const createApplication: <const Features extends readonly AnyFeature[]>(definition: {
  readonly features: Features;
  readonly adapters?: readonly BoundPortAdapter[];
  readonly mode?: "development" | "test" | "production";
}) => Application<ApplicationOperations<Features>>;

/* ================================================================== */
/* USAGE — the exact shape from design-v2.md D1                       */
/* ================================================================== */

const Note = s.object({
  id: s.id("NoteId"),
  title: s.string({ min: 1, max: 200 }),
  body: s.string(),
});
type NoteT = Infer<typeof Note>;

const NoteStorage = port("noteStorage", {
  save: port.write({ input: Note, output: Note }),
  get: port.read({ input: s.id("NoteId"), output: s.optional(Note) }),
});

// effect errors default to `never` when omitted
type SaveErr = DeclaredError<(typeof NoteStorage)["operations"]["save"]["errors"]>;
const _saveErrIsNever: [SaveErr] extends [never] ? true : never = true;
void _saveErrIsNever;

const noteCreated = event("notes.created", 1, Note);

const notes = feature("notes", {
  ports: [NoteStorage],
  operations: {
    create: command({
      input: s.object({ title: Note.shape.title, body: Note.shape.body }),
      output: Note,
      errors: { NOTE_EXISTS: s.object({ id: s.id("NoteId") }) },
      permissions: ["notes:create"],
      http: {
        method: "POST",
        path: "/notes",
        status: 201,
        errorStatus: { NOTE_EXISTS: 409 },
      },
      effects: { save: NoteStorage.operations.save },
      emits: { created: noteCreated },
      async execute({ input, effects, emit }) {
        // Q2: effects.save must infer (input: NoteT) => MaybePromise<Outcome<NoteT, never>>
        const saved = await effects.save({
          id: "n1" as NoteT["id"],
          title: input.title,
          body: input.body,
        });
        // design-v2 snippet as written: propagate effect failure directly
        if (!saved.ok) return saved;
        emit.created(saved.value);
        // typo in emitted event name must fail
        // @ts-expect-error - "createdd" is not a declared emit key
        emit.createdd;
        // wrong payload must fail
        // @ts-expect-error - payload must be NoteT
        emit.created({ nope: true });
        // declared domain error with typed details
        if (input.title === "dupe") {
          return err("NOTE_EXISTS", { id: saved.value.id });
        }
        return ok(saved.value);
      },
    }),
    get: query({
      input: s.id("NoteId"),
      output: s.optional(Note),
      permissions: ["notes:read"],
      http: { method: "GET", path: "/notes/:id" },
      effects: { load: NoteStorage.operations.get },
      async execute({ input, effects }) {
        // input must be the branded NoteId string
        const branded: string & { __brand: "NoteId" } = input;
        void branded;
        const found = await effects.load(input);
        if (!found.ok) return found;
        return ok(found.value);
      },
    }),
  },
});

/* --- Q2 standalone check: effect handler types surface exactly --- */

type SaveHandler = EffectContext<{ save: (typeof NoteStorage)["operations"]["save"] }>["save"];
declare const saveHandler: SaveHandler;
type SaveInput = Parameters<SaveHandler>[0];
type _saveInCheck1 = SaveInput extends NoteT ? true : never;
type _saveInCheck2 = NoteT extends SaveInput ? true : never;
const _si1: _saveInCheck1 = true;
const _si2: _saveInCheck2 = true;
void _si1;
void _si2;
type SaveOut = Awaited<ReturnType<SaveHandler>>;
type SaveOkValue = Extract<SaveOut, { ok: true }>["value"];
const _so1: SaveOkValue extends NoteT ? (NoteT extends SaveOkValue ? true : never) : never = true;
void _so1;
// port op id derived: "noteStorage.save"
const savedOpId: "noteStorage.save" = NoteStorage.operations.save.id;
void savedOpId;
void saveHandler;

/* --- derived operation ids as literal types --- */

const createId: "notes.create" = notes.operations.create.id;
const getId: "notes.get" = notes.operations.get.id;
void createId;
void getId;
// @ts-expect-error - id is the exact template literal, not widened
const wrongId: "notes.remove" = notes.operations.create.id;
void wrongId;

/* --- Q1: typed dispatch by string id --- */

const adapters = [
  NoteStorage.adapter({
    save: async (note) => {
      // adapter impl param inferred as NoteT
      const t: string = note.title;
      void t;
      return ok(note);
    },
    get: async (id) => {
      const b: string & { __brand: "NoteId" } = id;
      void b;
      return ok(undefined);
    },
  }),
];

const app = createApplication({ features: [notes], adapters, mode: "production" });

declare const principal: Principal;

const run = async () => {
  const result = await app.dispatch("notes.create", {
    input: { title: "hello", body: "world" },
    principal,
  });
  if (result.kind === "completed" && result.outcome.ok) {
    // output typed as NoteT
    const title: string = result.outcome.value.title;
    void title;
  }
  if (result.kind === "completed" && !result.outcome.ok) {
    // error narrows to the declared union
    const code: "NOTE_EXISTS" = result.outcome.error.code;
    const detailsId: NoteT["id"] = result.outcome.error.details.id;
    void code;
    void detailsId;
  }

  // query dispatch with branded input
  const got = await app.dispatch("notes.get", {
    input: "n1" as NoteT["id"],
    principal,
  });
  void got;

  // NEGATIVE: unknown operation id
  // @ts-expect-error - "notes.remove" is not a known operation id
  await app.dispatch("notes.remove", { input: {}, principal });

  // NEGATIVE: wrong input shape for notes.create
  // @ts-expect-error - missing body
  await app.dispatch("notes.create", { input: { title: "x" }, principal });

  // NEGATIVE: plain string not assignable to branded NoteId
  // @ts-expect-error - branded id required
  await app.dispatch("notes.get", { input: "raw-string", principal });
};
void run;

/* --- errorStatus keys constrained to declared error codes --- */

const badHttp = () =>
  command({
    input: Note,
    output: Note,
    errors: { NOPE: s.object({}) },
    http: {
      method: "POST",
      path: "/x",
      // @ts-expect-error - TYPO_CODE is not a declared error code
      errorStatus: { TYPO_CODE: 400 },
    },
    async execute() {
      return err("NOPE", {});
    },
  });
void badHttp;

/* --- multi-feature app: ids stay disjoint and typed --- */

const tags = feature("tags", {
  operations: {
    list: query({
      input: s.object({}),
      output: s.object({ count: s.string() }),
      async execute() {
        return ok({ count: "0" });
      },
    }),
  },
});

// omitted errors/effects/emits on tags.list must default to empty, not the
// wide constraint maps (probe4 poisoning regression check)
type TagsListErr = DeclaredError<(typeof tags)["operations"]["list"]["errors"]>;
const _tagsErrNever: [TagsListErr] extends [never] ? true : never = true;
void _tagsErrNever;

const multi = createApplication({ features: [notes, tags] });
const runMulti = async () => {
  const r1 = await multi.dispatch("tags.list", { input: {}, principal });
  if (r1.kind === "completed" && !r1.outcome.ok) {
    // error type is never for an operation with no declared errors
    const impossible: never = r1.outcome.error;
    void impossible;
  }
  const r2 = await multi.dispatch("notes.get", { input: "n1" as NoteT["id"], principal });
  void r1;
  void r2;
  // @ts-expect-error - cross-feature id mixup rejected
  await multi.dispatch("tags.get", { input: "n1" as NoteT["id"], principal });
};
void runMulti;

export {};
