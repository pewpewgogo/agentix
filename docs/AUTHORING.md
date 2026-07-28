# Authoring Cheat Sheet

Read this once before your first change. One feature = one file under
`src/features/`. A change to a feature touches exactly two files: the feature
file and its colocated test.

## The canonical feature file

`src/features/notes.ts` — schema, store port, operations, HTTP wiring, errors:

```ts
import { command, feature, port, query, s } from "@agentixdev/core";

export const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
  body: s.string(),
});
export type Note = s.Infer<typeof Note>;

export const NoteStorage = port.store("noteStorage", Note);

export const notes = feature("notes", {
  operations: {
    create: command({
      input: Note,
      output: Note,
      errors: { NOTE_ALREADY_EXISTS: { http: 409, details: { id: s.string() } } },
      http: { method: "POST", path: "/notes", status: 201 },
      effects: { load: NoteStorage.get, save: NoteStorage.save },
      async execute({ input, effects, fail }) {
        if (await effects.load(input.id)) return fail("NOTE_ALREADY_EXISTS", { id: input.id });
        return effects.save(input);
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Note,
      errors: { NOTE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      http: { method: "GET", path: "/notes/:id" },
      effects: { load: NoteStorage.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("NOTE_NOT_FOUND", { id: input.id });
      },
    }),
  },
});
```

Rules the runtime and compiler enforce:

- Operation ids are derived: `${featureId}.${key}` (here `notes.create`, `notes.get`).
- `execute` returns a plain output value or `fail(code, details)`. `fail` is
  typed against the `errors` map and RETURNS (never throw it).
- Effects are `Port.opName` references; only declared effects are callable.
  Adapters return plain values or throw — a throw becomes an `EFFECT_FAILURE` fault.
- Queries cannot declare write effects or emit events (type + runtime error).
- Object schemas reject unknown keys. `trim: true` normalizes before validation.
- Ambient I/O, clocks, randomness, `fetch`, and env access are compiler
  diagnostics inside `src/features/`.

## The 2-file change recipe

To add an operation (example: `notes.delete`):

1. `agentix inspect notes --root . --json --compact` — the bounded artifact
   shows operations, routes, errors, effects, and tests. Do not read the app shell.
2. Edit `src/features/notes.ts`: add one `command()`/`query()` entry to
   `operations`, declaring `input`, `output`, `errors`, `http`, `effects`.
   `port.store` already provides `get/save/delete/list` — no new port needed.
3. Edit `src/features/notes.test.ts`: add cases for the success path and each
   declared error code.
4. `agentix verify notes.delete --root .` — runs the narrowest safe typecheck +
   test commands.

`src/app.ts` does not change: routes are auto-derived from `http` metadata and
required adapters are derived from operation effects.

## Declaring errors and statuses

```ts
errors: {
  CODE_A: { http: 409, details: { id: s.string() } }, // status + details shape
  CODE_B: { http: 404 },                              // status, empty details
  CODE_C: { details: SomeSchema },                    // defaults to HTTP 422
  CODE_D: SomeSchema,                                 // bare schema shorthand
},
```

`fail("CODE_A", { id })` returns the declared failure; over HTTP it becomes
`{ "ok": false, "error": { "code": "CODE_A", "details": { ... } } }` with the
declared status (422 when no `http` was given).

## Ports

- `port.store(id, objectSchema)` — CRUD preset (schema must have `id`):
  `get(id) -> record | undefined`, `save(record) -> record`,
  `delete(id) -> boolean`, `list({}) -> record[]`, plus `.memory()` — a
  built-in Map adapter for the app shell and tests.
- Custom port: `port(id, { opName: port.read({ input, output }) })` with
  `port.read/write/time/random/external`. Expected alternatives (e.g. declined
  payment) belong in the output schema as a union — port ops have no error channel.
- Adapter: `MyPort.adapter({ opName: async (input) => value })`.

## When app.ts needs touching (almost never)

Only when you introduce a NEW feature or a NEW port:

```ts
export const app = createApplication({
  features: [notes],                 // + new feature
  adapters: [NoteStorage.memory()],  // + adapter for a new port
});
export const handler = createHttpHandler(app);
```

Everything else — routes, statuses, permissions, effects — lives on the
operation descriptor in the feature file.

## Verification commands

```sh
agentix inspect <feature-or-operation> --root . --json --compact  # bounded context
agentix verify <feature-or-operation> --root .   # narrow typecheck + tests
agentix scaffold feature <name> --root .         # new feature file + test
npm exec -- vitest run src/features/<name>.test.ts
npm exec -- tsc -b . --pretty false
```

`verify` exit codes: 0 pass, 1 verification failure, 2 invalid invocation,
3 internal failure. If `affected.widened` is true in inspect output, run the
workspace-level commands it prints instead of the narrow plan.
