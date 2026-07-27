/**
 * Type-level tests for the v2 authoring surface. Compiled by
 * tsconfig.type-tests.json; never executed. Mirrors the verified-d1 probe:
 * template-literal ids, guarded helper conditionals, fail() typing, effect
 * inference, and type-level query purity.
 */
import {
  command,
  createApplication,
  event,
  feature,
  ok,
  port,
  query,
  s,
  subscription,
  type AdapterCallOptions,
  type BoundPortAdapter,
  type BrandedId,
  type DeclaredError,
  type DispatchFaultCode,
  type DispatchObserver,
  type EffectContext,
  type OpError,
  type OpInput,
  type OpOutput,
  type Subscription,
} from "../src/index.js";

const Note = s.object({
  id: s.id("NoteId"),
  title: s.string({ min: 1, max: 200 }),
  body: s.string(),
});
type Note = s.Infer<typeof Note>;

/* --- s.Infer and branded ids ---------------------------------------- */

const validId: Note["id"] = s.id("NoteId").parse("n1");
const brandedAlias: BrandedId<"NoteId"> = validId;
void brandedAlias;
// @ts-expect-error - plain strings do not silently acquire an ID brand
const invalidId: Note["id"] = "n1";
void invalidId;

/* --- ports: derived template-literal op ids -------------------------- */

const NoteStorage = port("noteStorage", {
  save: port.write({ input: Note, output: Note }),
  get: port.read({ input: s.id("NoteId"), output: s.optional(Note) }),
});

const saveId: "noteStorage.save" = NoteStorage.save.id;
const saveViaOperations: "noteStorage.save" = NoteStorage.operations.save.id;
void saveId;
void saveViaOperations;
// @ts-expect-error - id is the exact template literal, not widened
const wrongSaveId: "noteStorage.get" = NoteStorage.save.id;
void wrongSaveId;

// @ts-expect-error - port operations must come from port.read/write/...
port("bogus", { nope: "not-an-operation" });

/* --- port.store: preset ops share the template-literal scheme -------- */

const NoteStore = port.store("noteStore", Note);
const storeGetId: "noteStore.get" = NoteStore.get.id;
const storeSaveId: "noteStore.save" = NoteStore.operations.save.id;
void storeGetId;
void storeSaveId;
type StoreGetInput = s.Infer<(typeof NoteStore)["get"]["input"]>;
const storeGetInput: StoreGetInput = validId;
void storeGetInput;
// @ts-expect-error - store get takes the branded id, not the record
const badStoreGetInput: StoreGetInput = { id: validId, title: "t", body: "b" };
void badStoreGetInput;
const storeMemory: BoundPortAdapter = NoteStore.memory();
void storeMemory;

/* --- adapters: typed implementations, non-generic bound adapter ------ */

const adapter: BoundPortAdapter = NoteStorage.adapter({
  save: (note) => {
    // adapter impl param inferred as Note
    const title: string = note.title;
    void title;
    return note;
  },
  get: (id) => {
    const branded: BrandedId<"NoteId"> = id;
    void branded;
    return undefined;
  },
});

// @ts-expect-error - adapters must implement the complete port contract
NoteStorage.adapter({ save: (note) => note });

NoteStorage.adapter({
  save: (note) => note,
  // @ts-expect-error - adapter outputs are typed by the port op output schema
  get: () => 42,
});

/* --- effect handler surface (Q2): plain values in, plain values out -- */

type SaveHandler = EffectContext<{ save: (typeof NoteStorage)["save"] }>["save"];
type SaveInput = Parameters<SaveHandler>[0];
const saveInputCheck1: SaveInput extends Note ? true : never = true;
const saveInputCheck2: Note extends SaveInput ? true : never = true;
void saveInputCheck1;
void saveInputCheck2;
type SaveOutput = Awaited<ReturnType<SaveHandler>>;
const saveOutputCheck: SaveOutput extends Note
  ? Note extends SaveOutput
    ? true
    : never
  : never = true;
void saveOutputCheck;

/* --- operations: unified errors, fail typing, emits, effects --------- */

const noteCreated = event("notes.created", 1, Note);
const eventId: "notes.created" = noteCreated.id;
const eventVersion: 1 = noteCreated.version;
void eventId;
void eventVersion;

const notes = feature("notes", {
  operations: {
    create: command({
      input: s.object({ title: Note.shape.title, body: Note.shape.body }),
      output: Note,
      errors: {
        NOTE_EXISTS: { http: 409, details: { id: s.id("NoteId") } },
        VAULT_SEALED: { http: 423 },
        BAD_TITLE: s.object({ reason: s.string() }),
      },
      permissions: ["notes:create"],
      http: { method: "POST", path: "/notes", status: 201 },
      effects: { save: NoteStorage.save, load: NoteStorage.get },
      emits: { created: noteCreated },
      async execute({ input, effects, emit, fail }) {
        const existing = await effects.load(validId);
        // effect handlers return plain (validated) values, not Outcomes
        const plain: Note | undefined = existing;
        void plain;
        const saved = await effects.save({
          id: validId,
          title: input.title,
          body: input.body,
        });
        const savedTitle: string = saved.title;
        void savedTitle;
        emit.created(saved);
        // @ts-expect-error - "createdd" is not a declared emit alias
        emit.createdd;
        // @ts-expect-error - event payloads are schema-inferred
        emit.created({ nope: true });
        if (input.title === "dupe") return fail("NOTE_EXISTS", { id: saved.id });
        if (input.title === "sealed") return fail("VAULT_SEALED");
        if (input.title === "bad") return fail("BAD_TITLE", { reason: "bad" });
        // @ts-expect-error - fail rejects unknown error codes
        void fail("TYPO_CODE");
        // @ts-expect-error - fail details are typed per error code
        void fail("NOTE_EXISTS", { id: 5 });
        // @ts-expect-error - details are required when the error declares them
        void fail("NOTE_EXISTS");
        // @ts-expect-error - detail-less errors accept no extra detail keys
        void fail("VAULT_SEALED", { nope: true });
        return saved;
      },
    }),
    get: query({
      input: s.id("NoteId"),
      output: s.optional(Note),
      permissions: ["notes:read"],
      effects: { load: NoteStorage.get },
      async execute({ input, effects }) {
        const branded: BrandedId<"NoteId"> = input;
        void branded;
        return effects.load(input);
      },
    }),
  },
});

/* --- execute must return plain output, not ok()/err() outcomes ------- */

const outcomeReturn = () =>
  command({
    input: s.object({}),
    output: s.boolean(),
    // @ts-expect-error - v1-style Outcome wrapping is rejected at the type level
    async execute() {
      return ok(true);
    },
  });
void outcomeReturn;

/* --- queries reject write effects at the type level ------------------ */

const writeQuery = () =>
  query({
    input: s.object({}),
    output: Note,
    // @ts-expect-error - write effects are rejected on queries
    effects: { save: NoteStorage.save },
    async execute() {
      return { id: validId, title: "t", body: "b" };
    },
  });
void writeQuery;

/* --- feature: derived operation ids as literal types ------------------ */

const createId: "notes.create" = notes.operations.create.id;
const getId: "notes.get" = notes.operations.get.id;
void createId;
void getId;
// @ts-expect-error - id is the exact template literal, not widened
const wrongId: "notes.remove" = notes.operations.create.id;
void wrongId;

// @ts-expect-error - operations must be command()/query() descriptors
feature("bogus", { operations: { nope: 42 } });

/* --- OpInput/OpOutput/OpError narrowing ------------------------------- */

type CreateOp = (typeof notes)["operations"]["create"];
const opInput: OpInput<CreateOp> = { title: "t", body: "b" };
void opInput;
// @ts-expect-error - body is required
const badOpInput: OpInput<CreateOp> = { title: "t" };
void badOpInput;
const opOutput: OpOutput<CreateOp> = { id: validId, title: "t", body: "b" };
void opOutput;
const opError: OpError<CreateOp> = {
  code: "NOTE_EXISTS",
  details: { id: validId },
};
void opError;
const emptyDetailsError: OpError<CreateOp> = { code: "VAULT_SEALED", details: {} };
void emptyDetailsError;
// @ts-expect-error - unknown error codes are not part of the union
const badOpError: OpError<CreateOp> = { code: "NOTE_EXIST", details: { id: validId } };
void badOpError;

/* --- omitted optional maps default to empty, not the wide constraint -- */

const tags = feature("tags", {
  operations: {
    list: query({
      input: s.object({}),
      output: s.object({ count: s.number() }),
      async execute() {
        return { count: 0 };
      },
    }),
  },
});

type TagsListErr = DeclaredError<(typeof tags)["operations"]["list"]["errors"]>;
const tagsErrIsNever: [TagsListErr] extends [never] ? true : never = true;
void tagsErrIsNever;

/* --- application: dispatch/call typed by template-literal id ---------- */

const app = createApplication({
  features: [notes, tags],
  adapters: [adapter],
  mode: "test",
});

const run = async (): Promise<void> => {
  const result = await app.dispatch("notes.create", {
    input: { title: "hello", body: "world" },
  });
  if (result.kind === "completed" && result.outcome.ok) {
    const title: string = result.outcome.value.title;
    void title;
  }
  if (result.kind === "completed" && !result.outcome.ok) {
    const code: "NOTE_EXISTS" | "VAULT_SEALED" | "BAD_TITLE" =
      result.outcome.error.code;
    void code;
    if (result.outcome.error.code === "NOTE_EXISTS") {
      const detailsId: Note["id"] = result.outcome.error.details.id;
      void detailsId;
    }
  }

  // query dispatch with branded input
  const got = await app.dispatch("notes.get", { input: validId });
  void got;

  // @ts-expect-error - "notes.remove" is not a known operation id
  await app.dispatch("notes.remove", { input: {} });
  // @ts-expect-error - missing body
  await app.dispatch("notes.create", { input: { title: "x" } });
  // @ts-expect-error - plain string not assignable to branded NoteId
  await app.dispatch("notes.get", { input: "raw-string" });
  // @ts-expect-error - cross-feature id mixup rejected
  await app.dispatch("tags.create", { input: { title: "x", body: "y" } });

  // dispatch by descriptor is equally typed
  const byDescriptor = await app.dispatch(notes.operations.get, { input: validId });
  void byDescriptor;

  // multi-feature: an operation with no declared errors narrows to never
  const listed = await app.dispatch("tags.list", { input: {} });
  if (listed.kind === "completed" && !listed.outcome.ok) {
    const impossible: never = listed.outcome.error;
    void impossible;
  }

  // call(): typed outcome sugar
  const outcome = await app.call("notes.create", { title: "t", body: "b" });
  if (outcome.ok) {
    const created: Note = outcome.value;
    void created;
  } else {
    const code: "NOTE_EXISTS" | "VAULT_SEALED" | "BAD_TITLE" = outcome.error.code;
    void code;
  }
  // @ts-expect-error - call input is typed by the operation id
  await app.call("notes.create", { title: 1, body: "b" });
  // @ts-expect-error - unknown operation ids are rejected on call
  await app.call("notes.remove", {});

  // dispatch options: meta is opaque, signal is a real AbortSignal
  await app.dispatch("notes.get", {
    input: validId,
    meta: { requestId: "req-1" },
    signal: new AbortController().signal,
  });
  // @ts-expect-error - signal must be an AbortSignal, not a boolean
  await app.dispatch("notes.get", { input: validId, signal: true });

  // lifecycle: start() resolves to the same typed app; close() is void
  const startedApp = await app.start();
  const startedResult = await startedApp.dispatch("notes.get", { input: validId });
  void startedResult;
  const closed: void = await app.close();
  void closed;
};
void run;

/* --- new dispatch fault codes are part of the union ------------------- */

const abortedCode: DispatchFaultCode = "DISPATCH_ABORTED";
const timeoutCode: DispatchFaultCode = "EFFECT_TIMEOUT";
const closedCode: DispatchFaultCode = "APPLICATION_CLOSED";
void abortedCode;
void timeoutCode;
void closedCode;
// @ts-expect-error - unknown fault codes stay rejected
const bogusCode: DispatchFaultCode = "DISPATCH_CANCELLED";
void bogusCode;

/* --- execute context exposes the dispatch signal ---------------------- */

const signalled = command({
  input: s.object({}),
  output: s.boolean(),
  async execute({ signal }) {
    const live: AbortSignal = signal;
    void live;
    return !signal.aborted;
  },
});
void signalled;

/* --- adapters: single-arg and (input, { signal }) both typecheck ------- */

const dualAdapter: BoundPortAdapter = NoteStorage.adapter({
  save: (note, options) => {
    const opts: AdapterCallOptions = options;
    const signal: AbortSignal = opts.signal;
    void signal;
    return note;
  },
  get: (id) => {
    void id;
    return undefined;
  },
});
void dualAdapter;

NoteStorage.adapter(
  { save: (note) => note, get: () => undefined },
  { init: async () => {}, dispose: () => {} },
);
NoteStorage.adapter(
  { save: (note) => note, get: () => undefined },
  // @ts-expect-error - hooks must be functions
  { init: "connect" },
);

/* --- port operations accept timeoutMs; port.store takes options -------- */

const TimedPort = port("timedPort", {
  fetch: port.external({ input: s.object({}), output: s.string(), timeoutMs: 250 }),
});
const timedMs: number | undefined = TimedPort.fetch.timeoutMs;
void timedMs;
port.store("timedStore", Note, { timeoutMs: 100 });
// @ts-expect-error - timeoutMs is a number
port.store("badTimedStore", Note, { timeoutMs: "fast" });

/* --- subscriptions: payload inferred from the event descriptor --------- */

const typedSubscription = subscription(noteCreated, async (payload, context) => {
  const title: string = payload.title;
  const operationId: string = context.operationId;
  void title;
  void operationId;
});
const erased: Subscription = typedSubscription;
void erased;
subscription(noteCreated, (payload) => {
  // @ts-expect-error - payload is a Note, not a string
  const wrong: string = payload;
  void wrong;
});
// @ts-expect-error - only event() descriptors are subscribable
subscription({ id: "nope" }, async () => {});

/* --- observer: partial implementations are fine; ctx shapes typed ------ */

const observer: DispatchObserver = {
  dispatchStarted(ctx) {
    const id: string = ctx.operationId;
    const principalId: string | undefined = ctx.principalId;
    void id;
    void principalId;
    return { spanId: "s1" };
  },
  dispatchSettled(ctx) {
    const kind: "completed" | "rejected" | "fault" = ctx.kind;
    const duration: bigint = ctx.durationNs;
    void kind;
    void duration;
  },
};
void observer;

createApplication({
  features: [notes, tags],
  adapters: [adapter],
  mode: "test",
  observer: { effectSettled: () => {} },
  subscribers: [typedSubscription],
});

/* --- s.record and s.tuple ---------------------------------------------- */

const Counts = s.record(s.number({ int: true }));
type Counts = s.Infer<typeof Counts>;
const countsValue: Counts = { a: 1, b: 2 };
void countsValue;
// @ts-expect-error - record values are typed by the value schema
const badCounts: Counts = { a: "one" };
void badCounts;

const Pair = s.tuple([s.string(), s.number()]);
type Pair = s.Infer<typeof Pair>;
const pairValue: Pair = ["a", 1];
void pairValue;
// @ts-expect-error - tuple element order is enforced
const swappedPair: Pair = [1, "a"];
void swappedPair;
// @ts-expect-error - tuple length is fixed
const shortPair: Pair = ["a"];
void shortPair;

export {};
