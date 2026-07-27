# Getting Started

One complete Agentix feature from install to verified HTTP endpoint. A feature
is a single TypeScript file; the application shell is a second, rarely-touched
file.

## Install

Requirements: Node.js `>=22.12.0 <25`, npm `>=11 <12`, TypeScript with NodeNext
module resolution (relative imports use `.js` suffixes).

```sh
mkdir agentix-notes && cd agentix-notes
npm init -y && npm pkg set type=module
npm install @agentix/core @agentix/adapters-http
npm install --save-dev @agentix/cli @agentix/testing typescript vitest
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

## 1. The feature file

`src/features/notes.ts` — schema, storage port, and both operations. This one
file is the feature's public contract:

```ts
import { command, feature, port, query, s } from "@agentix/core";

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

What each block declares:

- `s.object(...)` — runtime schema; unknown keys are rejected, `trim` runs
  before validation. `s.Infer` derives the static type.
- `port.store("noteStorage", Note)` — a CRUD port (`get/save/delete/list`)
  plus a built-in `.memory()` adapter.
- `command`/`query` — input/output schemas, typed errors with their HTTP
  status, the route, and the exact effects `execute` may call. Operation ids
  derive from the feature id: `notes.create`, `notes.get`.
- `fail(code, details)` — returns the declared domain failure; it is typed
  against the `errors` map.

## 2. The application shell

`src/app.ts` — assemble features and adapters; HTTP routes are derived:

```ts
import { createHttpHandler } from "@agentix/adapters-http";
import { createApplication } from "@agentix/core";

import { notes, NoteStorage } from "./features/notes.js";

export const app = createApplication({
  features: [notes],
  adapters: [NoteStorage.memory()],
});

export const handler = createHttpHandler(app);
```

`createApplication` validates at startup: duplicate ids, adapter coverage for
every declared effect, query purity, and HTTP route conflicts. Routes come
from the operations' `http` metadata — there is no route table to maintain.

## 3. Serve it

`src/serve.ts`:

```ts
import { serveNode } from "@agentix/adapters-http";

import { handler } from "./app.js";

const server = await serveNode(handler, { port: 3000 });
console.log(`listening on ${server.url}`);
```

```sh
npx tsc -b . && node dist/serve.js
curl -s -X POST localhost:3000/notes -d '{"id":"n1","title":"First","body":""}'
# {"ok":true,"value":{"id":"n1","title":"First","body":""}}
curl -s localhost:3000/notes/n1
```

Edge runtimes skip `serveNode` and use `handler.fetch(request)` directly.

## 4. Test it

`src/features/notes.test.ts` — HTTP-level, no server socket:

```ts
import { testHttp } from "@agentix/testing";
import { describe, expect, it } from "vitest";

import { handler } from "../app.js";

const http = testHttp(handler);

describe("notes over HTTP", () => {
  it("creates a note and reads it back", async () => {
    const created = await http.post("/notes", { id: "n1", title: "First", body: "" });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      ok: true,
      value: { id: "n1", title: "First", body: "" },
    });

    const read = await http.get("/notes/n1");
    expect(read.status).toBe(200);
  });

  it("returns the declared conflict and not-found statuses", async () => {
    await http.post("/notes", { id: "n2", title: "First", body: "" });
    const duplicate = await http.post("/notes", { id: "n2", title: "Again", body: "" });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      ok: false,
      error: { code: "NOTE_ALREADY_EXISTS", details: { id: "n2" } },
    });

    expect((await http.get("/notes/missing")).status).toBe(404);
  });
});
```

```sh
npx vitest run
```

For dispatch-level tests without HTTP, call operations directly:
`await app.call("notes.create", { id: "n1", title: "First", body: "" })`
returns `{ ok: true, value }` or `{ ok: false, error }`.

## 5. Inspect it

```sh
npm exec -- agentix inspect notes.create --root . --json --compact
```

The CLI analyzes source (caching by digest in `.agentix/index.json`) and
returns a bounded `operation-context` artifact: route, errors with statuses,
effects, permissions, tests, bounded source excerpts of the schemas and
`execute`, plus the conservative `affected` scope and the narrowest safe
`verification` plan. Use it instead of reading the whole application.

## Next

- [AUTHORING.md](AUTHORING.md) — the change recipe (read before editing).
- [CORE_CONCEPTS.md](CORE_CONCEPTS.md) — the execution model.
- [HTTP.md](HTTP.md) — envelope, auth, overrides, hosts.
- [TESTING.md](TESTING.md) — test application, fakes, harnesses.
- [CLI.md](CLI.md) — all commands and artifact shapes.
