# `@agentixdev/adapters-http`

Automatic HTTP for [Agentix](https://pewpewgogo.github.io/agentix/)
applications: routes are derived from each operation's `http` metadata, the
JSON envelope is fixed, and the same handler serves Node (raw `node:http` fast
path) and edge runtimes (Web `fetch`).

```sh
npm install @agentixdev/core @agentixdev/adapters-http
```

Entries: package root (everything), `./web` (edge-safe, no Node built-ins),
`./node` (`serveNode`). Agentix is research-stage, ESM-only, and pre-1.0.

## Example

```ts
import {
  createBearerPrincipalExtractor,
  createHttpHandler,
  serveNode,
} from "@agentixdev/adapters-http";
import { createApplication } from "@agentixdev/core";

import { notes, NoteStorage } from "./features/notes.js";

const app = createApplication({
  features: [notes],
  adapters: [NoteStorage.memory()],
});

const handler = createHttpHandler(app, {
  authenticate: createBearerPrincipalExtractor({
    resolve: async (token) =>
      token === "s3cret" ? { id: "cli", permissions: ["notes:write"] } : null,
  }),
});

const server = await serveNode(handler, { port: 3000 });
console.log(server.url);

// Edge runtimes instead export the Web entry:
// export default { fetch: (request: Request) => handler.fetch(request) };
```

With `http: { method: "POST", path: "/notes", status: 201 }` on the operation
and `errors: { NOTE_ALREADY_EXISTS: { http: 409, ... } }`, the handler answers:

| Case | Status | Body |
| --- | --- | --- |
| success | 201 | `{"ok":true,"value":...}` |
| declared error | 409 (else 422) | `{"ok":false,"error":{"code":...,"details":...}}` |
| invalid input | 400 | `{"ok":false,"error":{"code":"INVALID_INPUT","issues":[...]}}` |
| missing permission | 403 (before body read) | opaque `PERMISSION_DENIED` |
| defect | 500 | opaque `INTERNAL` |

Route overrides (custom paths/mappings) go through `defineHttpRoute` in the
handler's `routes` option; there is no other mapping surface.

## Docs

- [API.md](API.md) — every export, one-line signatures (shipped with the package).
- [HTTP guide](https://pewpewgogo.github.io/agentix/HTTP.html) — full envelope
  table, auth, routing rules, custom hosts.
