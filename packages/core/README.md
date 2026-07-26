# `@agentix/core`

Schemas, operation descriptors, ports, events, and the dispatch runtime of the
[Agentix](https://pewpewgogo.github.io/agentix/) TypeScript framework. One
feature is one file: every operation declares its input/output schemas, typed
errors (with HTTP status), permissions, effects, and route in one place, and
the application derives everything else.

```sh
npm install @agentix/core
```

Agentix is research-stage, ESM-only, and pre-1.0.

## Example

```ts
import { command, createApplication, feature, port, query, s } from "@agentix/core";

const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
  body: s.string(),
});

const NoteStorage = port.store("noteStorage", Note);

const notes = feature("notes", {
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

const app = createApplication({
  features: [notes],
  adapters: [NoteStorage.memory()],
});

const outcome = await app.call("notes.create", { id: "n1", title: "First", body: "" });
// { ok: true, value: { id: "n1", title: "First", body: "" } }
// duplicate id => { ok: false, error: { code: "NOTE_ALREADY_EXISTS", details: { id: "n1" } } }
```

`app.dispatch(id, { input, principal?, trace? })` exposes the full three-way
result (`completed` outcome + events, `rejected` for permission/validation,
`fault` for defects). Startup validates duplicate ids, adapter coverage for
every declared effect, query purity, and HTTP route conflicts. Production mode
keeps every external boundary validated and skips only interior double-checks.

## Docs

- [API.md](API.md) — every export, one-line signatures (shipped with the package).
- [Core concepts](https://pewpewgogo.github.io/agentix/CORE_CONCEPTS.html) —
  the execution model.
- [Authoring cheat sheet](https://pewpewgogo.github.io/agentix/AUTHORING.html) —
  the 2-file change recipe.
