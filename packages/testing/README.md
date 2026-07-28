# `@agentixdev/testing`

Deterministic testing for [Agentix](https://pewpewgogo.github.io/agentix/)
applications: a test application that auto-fakes uncovered ports (recording
every call), an HTTP driver over any `fetch` handler, dispatch harnesses,
deterministic clocks/ids, adapter contracts, and trace assertions.

```sh
npm install --save-dev @agentixdev/testing
```

Agentix is research-stage, ESM-only, and pre-1.0.

## Example

```ts
import { createTestApplication, testHttp } from "@agentixdev/testing";
import { createHttpHandler } from "@agentixdev/adapters-http";
import { describe, expect, it } from "vitest";

import { notes } from "./features/notes.js";

describe("notes", () => {
  it("creates a note through the real dispatcher with a faked store", async () => {
    // No adapters passed: the store port gets an in-memory recording fake.
    const { app, calls } = createTestApplication({ features: [notes] });

    const outcome = await app.call("notes.create", { id: "n1", title: "First", body: "" });

    expect(outcome).toEqual({
      ok: true,
      value: { id: "n1", title: "First", body: "" },
    });
    expect(calls.of("noteStorage.save")).toHaveLength(1);
  });

  it("answers the declared statuses over HTTP without a socket", async () => {
    const { app } = createTestApplication({ features: [notes] });
    const http = testHttp(createHttpHandler(app));

    const created = await http.post("/notes", { id: "n1", title: "First", body: "" });
    expect(created.status).toBe(201);

    const duplicate = await http.post("/notes", { id: "n1", title: "Again", body: "" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      ok: false,
      error: { code: "NOTE_ALREADY_EXISTS", details: { id: "n1" } },
    });
  });
});
```

`createTestApplication` binds every reachable port operation: your adapters
win; `port.store` ports get the memory adapter, `time` ops a deterministic
clock (`2000-01-01T00:00:00.000Z`, +1s per call), `random` ops seeded ids
(`"id-1"`, ...); anything else throws until overridden via
`overrides: { "portId.opKey": handler }`.

## Docs

- [API.md](API.md) — every export, one-line signatures (shipped with the package).
- [Testing guide](https://pewpewgogo.github.io/agentix/TESTING.html) —
  harnesses, contracts, recording adapters, ensures helpers.
