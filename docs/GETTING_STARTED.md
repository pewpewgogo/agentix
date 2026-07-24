# Getting Started

This guide takes you from a clean clone to one complete Agentix feature. It uses
the repository workspaces because Agentix is not published to npm yet.

## Prerequisites

- Node.js `>=24 <25`
- npm `>=11 <12`
- Git

The exact dependency graph is pinned in `package-lock.json`.

```sh
git clone git@github.com:pewpewgogo/agentix.git
cd agentix
npm ci
npm run build
npm run verify
```

`npm run build` emits the workspace packages and makes the CLI binary
executable. `npm run verify` then runs the strict project-reference typecheck
and complete Vitest suite. No package is installed globally.

## Tour the reference application

The framework commerce application contains customers, products, payments, and
orders. Start from an operation instead of opening the entire tree:

```sh
npm exec -- agentix inspect orders.create --root examples/framework-app
```

The output points to the declaration and lists its permission, seven effects,
event, invariant, associated tests, verification scope, and compiler trust. The
JSON form is a source-derived operation context with a hard 8 KiB limit; it is
not the full generated index. Check `projection.truncated` and follow any
machine-readable `projection.omissions` expansion before assuming a list is
complete. Try the other views:

```sh
npm exec -- agentix graph orders --root examples/framework-app
npm exec -- agentix affected src/features/orders/contract.ts \
  --root examples/framework-app
npm exec -- agentix inspect orders.create \
  --root examples/framework-app --json --compact
```

The compact form preserves every field while removing indentation overhead from
agent context. Omit `--compact` when you want indented JSON for manual reading.

Run the behavior shared with the plain TypeScript implementation:

```sh
npm run test:acceptance
```

## Understand a minimal feature capsule

The declarations below are a complete, type-checked API example. They assume an
Agentix application workspace inside this clone; the packages cannot yet be
installed into an unrelated project from npm. Use them as a small companion to
the runnable `examples/framework-app`, not as a claim that a published starter
package already exists.

A small feature normally has a public contract, operations, a feature
descriptor, and tests:

```text
src/features/notes/
  contract.ts
  operations.ts
  feature.ts
  notes.test.ts
```

The CLI can preview the minimal three-file scaffold without writing anything.
It creates a contract, feature descriptor, and test; add operations, models, and
invariants only when the feature needs them:

```sh
npm exec -- agentix scaffold feature notes --root path/to/your-app --dry-run
```

The following smaller example shows the essential declarations. Application
package configuration follows the same pattern as
[`examples/framework-app/package.json`](../examples/framework-app/package.json)
and its TypeScript project files.

### 1. Declare schemas and a port

Create `src/features/notes/contract.ts`:

```ts
import {
  defineFeatureContract,
  definePort,
  portOperation,
  schema,
  type Infer,
} from "@agentix/core";

export const NoteId = schema.id("note");

export const Note = schema.object({
  id: NoteId,
  body: schema.refine(
    schema.string(),
    (value) => value.trim().length > 0,
    { id: "note-body", message: "A note body must not be empty" },
  ),
});

export type Note = Infer<typeof Note>;

export const NoteStore = definePort({
  id: "note-store",
  operations: {
    save: portOperation({
      id: "note-store.save",
      kind: "write",
      input: Note,
      output: Note,
      errors: {
        NOTE_ALREADY_EXISTS: schema.object({ id: NoteId }),
      },
    }),
  },
});

export const notesContract = defineFeatureContract({
  id: "notes",
  exports: { Note, NoteId, NoteStore },
});
```

Schemas provide both runtime parsing and inferred TypeScript types. The branded
`NoteId` prevents accidental use of another entity's ID at compile time. The
port says that persistence is a write effect, but it does not choose a database.

### 2. Declare a command

Create `src/features/notes/operations.ts`:

```ts
import { defineCommand, schema } from "@agentix/core";

import { Note, NoteId, NoteStore } from "./contract.js";

export const createNote = defineCommand({
  id: "notes.create",
  input: Note,
  output: Note,
  errors: {
    NOTE_ALREADY_EXISTS: schema.object({ id: NoteId }),
  },
  permissions: ["notes:create"],
  effects: {
    save: NoteStore.operations.save,
  },
  emits: {},
  async execute({ input, effects }) {
    return effects.save({ ...input, body: input.body.trim() });
  },
});
```

`execute` receives only the `save` capability declared by this command. It
cannot obtain another application adapter from a container or global registry.
Expected failures are returned as typed outcomes by the adapter; unexpected
exceptions remain faults.

### 3. Assemble the feature

Create `src/features/notes/feature.ts`:

```ts
import { defineFeature } from "@agentix/core";

import { NoteStore, notesContract } from "./contract.js";
import { createNote } from "./operations.js";

export const notes = defineFeature({
  id: "notes",
  contract: notesContract,
  dependencies: [],
  operations: [createNote],
  invariants: [],
  events: [],
  ports: [NoteStore],
});
```

The feature and contract IDs must match. Cross-feature dependencies are public
contract values in `dependencies`, never implicit imports from another
feature's private files.

## Bind infrastructure and create the application

Create `src/application.ts`:

```ts
import {
  bindPort,
  createApplication,
  domainError,
  err,
  ok,
} from "@agentix/core";

import { NoteStore, type Note } from "./features/notes/contract.js";
import { notes } from "./features/notes/feature.js";

const storedNotes = new Map<string, Note>();

const noteStore = bindPort(NoteStore, {
  save(note) {
    if (storedNotes.has(note.id)) {
      return err(domainError("NOTE_ALREADY_EXISTS", { id: note.id }));
    }
    storedNotes.set(note.id, note);
    return ok(note);
  },
});

export const application = createApplication({
  features: [notes],
  adapters: [noteStore],
  mode: "development",
});
```

Application construction rejects duplicate IDs, missing feature dependencies,
query write effects, missing adapters, and incomplete or mismatched adapters.
The same port can be bound to memory in tests and to real infrastructure in a
host application.

## Dispatch the command

```ts
import { principal } from "@agentix/core";

import { application } from "./application.js";
import { Note } from "./features/notes/contract.js";
import { createNote } from "./features/notes/operations.js";

const result = await application.dispatch(createNote, {
  input: Note.parse({ id: "note-1", body: "Learn Agentix" }),
  principal: principal("developer", ["notes:create"]),
});

if (result.kind === "completed" && result.outcome.ok) {
  console.log(result.outcome.value);
}
```

A dispatch has two layers:

- `kind: "completed"` contains either a successful value or an expected typed
  domain error, plus the validated events emitted by the completed execution.
- `kind: "rejected"` represents an unknown operation, missing permission, or
  invalid input. No operation code runs.
- `kind: "fault"` represents an unexpected execution or boundary failure.

Authorization runs before input parsing. Development and test applications add
an effect/event trace by default; production applications do not unless a
dispatch opts in. Completed events are available independently of tracing; they
are not automatically published or persisted.

## Expose the operation through HTTP

Agentix routes use Web-standard `Request` and `Response` values. A thin adapter
connects them to Node's HTTP server:

```ts
import { createServer } from "node:http";

import {
  createHttpHandler,
  createTrustedHeaderPrincipalExtractor,
  defineHttpRoute,
  readJsonBody,
} from "@agentix/adapters-http/web";
import { createNodeHttpListener } from "@agentix/adapters-http/node";
import type { Infer } from "@agentix/core";

import { application } from "./application.js";
import { createNote } from "./features/notes/operations.js";

const handler = createHttpHandler({
  application,
  principal: createTrustedHeaderPrincipalExtractor(),
  routes: [
    defineHttpRoute({
      method: "POST",
      path: "/notes",
      operation: createNote,
      mapRequest: async ({ request }) =>
        await readJsonBody(request) as Infer<typeof createNote.input>,
      responses: {
        successStatus: 201,
        domainErrorStatuses: { NOTE_ALREADY_EXISTS: 409 },
      },
    }),
  ],
});

const server = createServer(createNodeHttpListener(handler));
server.listen(3000, "127.0.0.1", () => {
  console.log("Agentix listening on http://127.0.0.1:3000");
});
```

Call it through the trusted-header example:

```sh
curl --request POST http://127.0.0.1:3000/notes \
  --header 'content-type: application/json' \
  --header 'x-principal-id: developer' \
  --header 'x-principal-permissions: notes:create' \
  --data '{"id":"note-1","body":"Learn Agentix"}'
```

`createTrustedHeaderPrincipalExtractor` is safe only behind a trusted proxy that
strips client-supplied identity headers and replaces them with verified values.
For bearer tokens, use `createBearerPrincipalExtractor` with an application-
owned token resolver. See the [HTTP guide](HTTP.md) for response mapping and
host security options.

## Verify the feature

Generate or refresh the index implicitly and ask Agentix for a conservative
verification plan:

```sh
npm exec -- agentix inspect notes.create --root path/to/your-app
npm exec -- agentix affected notes.create --root path/to/your-app
npm exec -- agentix verify notes.create --root path/to/your-app
```

`verify` narrows only when project references and test associations prove that
the smaller scope is safe. Otherwise it runs the application's workspace-level
`typecheck` and `test` scripts.

## Next steps

- Read [core concepts](CORE_CONCEPTS.md) before adding events or invariants.
- Use the [testing helpers](TESTING.md) to replace time, randomness, and external
  services deterministically.
- Read [CLI and generated index](CLI.md) before integrating Agentix into an
  agent workflow.
- Use the complete [`orders.create`](../examples/framework-app/src/features/orders/operations.ts)
  flow as the production-sized reference.
