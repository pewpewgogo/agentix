import { describe, expect, it, vi } from "vitest";
import { command, createApplication, feature, port, query, s } from "@agentix/core";
import type { RuntimeMode } from "@agentix/core";

import { createBearerPrincipalExtractor } from "./auth.js";
import { createHttpHandler } from "./handler.js";
import { defineHttpRoute } from "./route.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
});

const NoteStore = port.store("noteStore", Note);
const Flaky = port("flaky", {
  read: port.read({ input: s.object({}), output: s.object({}) }),
});

const executions = { create: 0 };

const notes = feature("notes", {
  operations: {
    create: command({
      input: Note,
      output: Note,
      errors: {
        NOTE_EXISTS: { http: 409, details: { id: s.string() } },
        NOTE_INVALID: { details: { reason: s.string() } },
      },
      permissions: ["notes:write"],
      http: { method: "POST", path: "/notes", status: 201 },
      effects: { load: NoteStore.get, save: NoteStore.save },
      async execute({ input, effects, fail }) {
        executions.create += 1;
        if (input.title === "invalid") return fail("NOTE_INVALID", { reason: "bad title" });
        if (await effects.load(input.id)) return fail("NOTE_EXISTS", { id: input.id });
        return effects.save(input);
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Note,
      errors: { NOTE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      http: { method: "GET", path: "/notes/:id" },
      effects: { load: NoteStore.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("NOTE_NOT_FOUND", { id: input.id });
      },
    }),
    latest: query({
      input: s.object({}),
      output: s.object({ latest: s.boolean() }),
      http: { method: "GET", path: "/notes/latest" },
      async execute() {
        return { latest: true };
      },
    }),
    remove: command({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: s.object({ removed: s.boolean() }),
      http: { method: "DELETE", path: "/notes/:id" },
      effects: { del: NoteStore.delete },
      async execute({ input, effects }) {
        return { removed: await effects.del(input.id) };
      },
    }),
  },
});

const search = feature("search", {
  operations: {
    run: query({
      input: s.object({
        term: s.string({ min: 1 }),
        limit: s.number({ int: true }),
        verbose: s.boolean(),
      }),
      output: s.object({
        term: s.string(),
        limit: s.number(),
        verbose: s.boolean(),
      }),
      http: { method: "GET", path: "/search/:term" },
      async execute({ input }) {
        return input;
      },
    }),
  },
});

const files = feature("files", {
  operations: {
    cell: query({
      input: s.object({ name: s.string(), section: s.string() }),
      output: s.object({ route: s.string(), name: s.string(), section: s.string() }),
      http: { method: "GET", path: "/files/:name/:section" },
      async execute({ input }) {
        return { route: "cell", ...input };
      },
    }),
    meta: query({
      input: s.object({ name: s.string() }),
      output: s.object({ route: s.string(), name: s.string() }),
      http: { method: "GET", path: "/files/:name/meta" },
      async execute({ input }) {
        return { route: "meta", name: input.name };
      },
    }),
  },
});

const prefs = feature("prefs", {
  operations: {
    update: command({
      input: s.object({
        title: s.optional(s.string({ min: 1 })),
        count: s.optional(s.number()),
      }),
      output: s.object({ received: s.string() }),
      http: { method: "PATCH", path: "/prefs" },
      async execute({ input }) {
        return { received: JSON.stringify(input) };
      },
    }),
  },
});

const chaos = feature("chaos", {
  operations: {
    boom: query({
      input: s.object({}),
      output: s.object({}),
      http: { method: "GET", path: "/boom" },
      effects: { read: Flaky.read },
      async execute({ effects }) {
        return effects.read({});
      },
    }),
    breach: command({
      input: s.object({}),
      output: s.object({ value: s.number() }),
      http: { method: "POST", path: "/breach" },
      ensures: { positive: { check: ({ output }) => output.value > 0 } },
      async execute() {
        return { value: -1 };
      },
    }),
  },
});

const makeApp = (mode: RuntimeMode = "test") =>
  createApplication({
    features: [notes, search, files, prefs, chaos],
    adapters: [
      NoteStore.memory(),
      Flaky.adapter({
        read: () => {
          throw new Error("kaboom");
        },
      }),
    ],
    mode,
  });

const authenticate = createBearerPrincipalExtractor({
  resolve: (token) =>
    token === "writer"
      ? { id: "user-writer", permissions: ["notes:write"] }
      : token === "reader"
        ? { id: "user-reader", permissions: [] }
        : null,
});

const makeHandler = (options: Parameters<typeof createHttpHandler>[1] = {}) =>
  createHttpHandler(makeApp(), options);

interface RequestInitLite {
  readonly method?: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const jsonRequest = (path: string, init: RequestInitLite = {}): Request =>
  new Request(`https://api.test${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      ...init.headers,
    },
    ...(init.rawBody !== undefined
      ? { body: init.rawBody }
      : init.body !== undefined
        ? { body: JSON.stringify(init.body) }
        : {}),
  });

/* ------------------------------------------------------------------ */
/* Envelope                                                           */
/* ------------------------------------------------------------------ */

describe("response envelope", () => {
  it("maps completed success to {ok:true,value} with the authored status", async () => {
    const handler = makeHandler({ authenticate });
    const response = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", body: { id: "n1", title: "First" } }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      value: { id: "n1", title: "First" },
    });
  });

  it("maps declared errors to their derived per-error http status", async () => {
    const handler = makeHandler({ authenticate });
    const create = () =>
      handler.fetch(
        jsonRequest("/notes", { method: "POST", token: "writer", body: { id: "dup", title: "Twice" } }),
      );
    await create();
    const conflict = await create();

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOTE_EXISTS", details: { id: "dup" } },
    });
  });

  it("defaults declared errors without an http status to 422", async () => {
    const handler = makeHandler({ authenticate });
    const response = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", body: { id: "n2", title: "invalid" } }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOTE_INVALID", details: { reason: "bad title" } },
    });
  });

  it("serves query success and derived 404 from the same auto route", async () => {
    const handler = makeHandler({ authenticate });
    await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", body: { id: "n3", title: "Kept" } }),
    );

    const found = await handler.fetch(jsonRequest("/notes/n3"));
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toEqual({
      ok: true,
      value: { id: "n3", title: "Kept" },
    });

    const missing = await handler.fetch(jsonRequest("/notes/none"));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "none" } },
    });
  });

  it("maps INVALID_INPUT rejections to 400 with schema issues", async () => {
    const handler = makeHandler({ authenticate });
    const before = executions.create;
    const response = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", body: { id: "n4" } }),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      ok: boolean;
      error: { code: string; issues: readonly { path: readonly string[] }[] };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("INVALID_INPUT");
    expect(payload.error.issues.some((issue) => issue.path[0] === "title")).toBe(true);
    expect(executions.create).toBe(before);
  });

  it("rejects unknown body keys (strict schema) with 400", async () => {
    const handler = makeHandler({ authenticate });
    const response = await handler.fetch(
      jsonRequest("/notes", {
        method: "POST",
        token: "writer",
        body: { id: "n5", title: "Ok", extra: 1 },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });

  it("answers 404 for unknown routes and lazy 405 with sorted Allow", async () => {
    const handler = makeHandler();
    const missing = await handler.fetch(jsonRequest("/nowhere"));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    const wrongMethod = await handler.fetch(jsonRequest("/notes/abc", { method: "PATCH" }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("DELETE, GET");
    await expect(wrongMethod.json()).resolves.toEqual({
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED" },
    });
  });

  it("maps empty POST bodies to schema-level 400, not adapter errors", async () => {
    const handler = makeHandler({ authenticate });
    const response = await handler.fetch(
      new Request("https://api.test/notes", {
        method: "POST",
        headers: { authorization: "Bearer writer" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });
});

/* ------------------------------------------------------------------ */
/* Authorization ordering                                             */
/* ------------------------------------------------------------------ */

describe("403 before body parse", () => {
  it("answers 403 (not 400) for malformed JSON when permission is missing", async () => {
    const handler = makeHandler(); // no authenticate: anonymous
    const before = executions.create;
    const response = await handler.fetch(
      jsonRequest("/notes", { method: "POST", rawBody: "{" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(executions.create).toBe(before);
  });

  it("answers 403 for authenticated principals without the permission", async () => {
    const handler = makeHandler({ authenticate });
    const response = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "reader", rawBody: "{" }),
    );

    expect(response.status).toBe(403);
  });

  it("answers 400 INVALID_JSON once the request IS authorized", async () => {
    const handler = makeHandler({ authenticate });
    const response = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", rawBody: "{" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_JSON" },
    });
  });

  it("keeps operations without permissions anonymous-accessible", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(jsonRequest("/notes/latest"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, value: { latest: true } });
  });
});

describe("authentication", () => {
  it("answers 401 for malformed Authorization headers", async () => {
    const handler = makeHandler({ authenticate });
    const response = await handler.fetch(
      jsonRequest("/notes/latest", { headers: { authorization: "Basic nope" } }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("treats unresolved tokens as anonymous, gated by authorize", async () => {
    const handler = makeHandler({ authenticate });
    const denied = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "stranger", body: { id: "x", title: "T" } }),
    );
    expect(denied.status).toBe(403);

    const open = await handler.fetch(jsonRequest("/notes/latest", { token: "stranger" }));
    expect(open.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Custom authorize hook (app.authorize is the effective gate)        */
/* ------------------------------------------------------------------ */

describe("custom authorize hook over HTTP", () => {
  const makeHookedHandler = (
    authorizeHook: Parameters<typeof createApplication>[0]["authorize"],
    options: Parameters<typeof createHttpHandler>[1] = {},
  ) =>
    createHttpHandler(
      createApplication({
        features: [notes],
        adapters: [NoteStore.memory()],
        mode: "test",
        authorize: authorizeHook,
      }),
      { authenticate, ...options },
    );

  it("honors a PERMISSIVE hook: 201 although the subset check denies (both entries)", async () => {
    // "reader" has no notes:write permission — the default gate answers 403
    // (see "403 before body parse"); the hook grants everyone.
    const handler = makeHookedHandler(() => true);

    const viaFetch = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "reader", body: { id: "hp1", title: "T" } }),
    );
    expect(viaFetch.status).toBe(201);
    await expect(viaFetch.json()).resolves.toEqual({
      ok: true,
      value: { id: "hp1", title: "T" },
    });

    const viaHandle = await handler.handle({
      method: "POST",
      path: "/notes",
      query: "",
      headers: (name) => (name === "authorization" ? "Bearer reader" : undefined),
      readBody: async () => JSON.stringify({ id: "hp2", title: "T" }),
    });
    expect(viaHandle.status).toBe(201);
    expect(JSON.parse(viaHandle.body)).toEqual({
      ok: true,
      value: { id: "hp2", title: "T" },
    });
  });

  it("honors a RESTRICTIVE hook: 403 BEFORE the body is read (both entries)", async () => {
    const handler = makeHookedHandler(() => false);

    // handle entry: the deferred body reader must never run.
    let bodyReads = 0;
    const viaHandle = await handler.handle({
      method: "POST",
      path: "/notes",
      query: "",
      headers: (name) => (name === "authorization" ? "Bearer writer" : undefined),
      readBody: async () => {
        bodyReads += 1;
        return JSON.stringify({ id: "x", title: "T" });
      },
    });
    expect(viaHandle.status).toBe(403);
    expect(JSON.parse(viaHandle.body)).toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(bodyReads).toBe(0);

    // fetch entry: malformed JSON answers 403 (not 400) — the body was never
    // parsed, although "writer" satisfies the default subset check.
    const viaFetch = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", rawBody: "{" }),
    );
    expect(viaFetch.status).toBe(403);
    await expect(viaFetch.json()).resolves.toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("answers 500 + onError when the authorize hook throws (#20)", async () => {
    const boom = new Error("policy service unreachable");
    const onError = vi.fn();
    const handler = makeHookedHandler(
      () => {
        throw boom;
      },
      { onError },
    );

    const response = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", body: { id: "x", title: "T" } }),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL" },
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        method: "POST",
        path: "/notes",
        operationId: "notes.create",
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Routing behavior through the Web entry                             */
/* ------------------------------------------------------------------ */

describe("routing", () => {
  it("prefers static routes over param routes deterministically", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(jsonRequest("/notes/latest"));
    await expect(response.json()).resolves.toEqual({ ok: true, value: { latest: true } });
  });

  it("matches percent-encoded static paths via the decoded second chance", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(jsonRequest("/notes/lates%74"));
    await expect(response.json()).resolves.toEqual({ ok: true, value: { latest: true } });
  });

  it("answers 405 with Allow for wrong-method requests on percent-encoded static paths", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(
      jsonRequest("/notes/lates%74", { method: "POST" }),
    );
    expect(response.status).toBe(405);
    // GET comes from the decoded static route /notes/latest; DELETE from the
    // /notes/:id param route which also matches the decoded segment.
    expect(response.headers.get("allow")).toBe("DELETE, GET");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED" },
    });
  });

  it("orders param routes static-segments-first", async () => {
    const handler = makeHandler();
    const meta = await handler.fetch(jsonRequest("/files/readme/meta"));
    await expect(meta.json()).resolves.toEqual({
      ok: true,
      value: { route: "meta", name: "readme" },
    });

    const cell = await handler.fetch(jsonRequest("/files/readme/intro"));
    await expect(cell.json()).resolves.toEqual({
      ok: true,
      value: { route: "cell", name: "readme", section: "intro" },
    });
  });

  it("decodes percent-encoded params into operation input", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(jsonRequest("/notes/a%20b"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "a b" } },
    });
  });

  it("skips candidates with malformed percent-encoding instead of aborting", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(jsonRequest("/notes/%zz"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("exposes the compiled route table", () => {
    const handler = makeHandler();
    const getBucket = handler.routes.buckets.get("GET");
    expect(getBucket?.staticRoutes.has("/notes/latest")).toBe(true);
    expect(getBucket?.paramRoutes[0]?.path).toBe("/files/:name/meta");
    expect(handler.routes.routes.length).toBeGreaterThanOrEqual(8);
  });
});

/* ------------------------------------------------------------------ */
/* Default request mapping (merge + coercion)                         */
/* ------------------------------------------------------------------ */

describe("default request mapping", () => {
  it("coerces number and boolean params/query per the input schema", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(
      jsonRequest("/search/widgets?limit=5&verbose=true"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      value: { term: "widgets", limit: 5, verbose: true },
    });
  });

  it("leaves non-coercible values for the schema to reject with issues", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(
      jsonRequest("/search/widgets?limit=abc&verbose=true"),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { code: string; issues: readonly { path: readonly string[] }[] };
    };
    expect(payload.error.code).toBe("INVALID_INPUT");
    expect(payload.error.issues.some((issue) => issue.path[0] === "limit")).toBe(true);
  });

  it("ignores query keys outside the input schema shape", async () => {
    const handler = makeHandler();
    const response = await handler.fetch(
      jsonRequest("/search/widgets?limit=2&verbose=false&utm_source=x"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      value: { term: "widgets", limit: 2, verbose: false },
    });
  });

  it("rejects non-object JSON bodies on object-schema routes with a 400 type issue", async () => {
    const handler = makeHandler();

    // All-optional schema (typical PATCH partial update): a discarded body
    // would silently succeed with {} — it must 400 instead. Both entries.
    const viaFetch = await handler.fetch(
      jsonRequest("/prefs", { method: "PATCH", rawBody: "[1,2]" }),
    );
    expect(viaFetch.status).toBe(400);
    const fetchPayload = (await viaFetch.json()) as {
      error: { code: string; issues: readonly { code: string; message: string }[] };
    };
    expect(fetchPayload.error.code).toBe("INVALID_INPUT");
    expect(fetchPayload.error.issues[0]).toMatchObject({
      code: "invalid_type",
      message: expect.stringContaining("Expected object"),
    });

    const viaHandle = await handler.handle({
      method: "PATCH",
      path: "/prefs",
      query: "",
      headers: () => undefined,
      readBody: async () => "[1,2]",
    });
    expect(viaHandle.status).toBe(400);
    const handlePayload = JSON.parse(viaHandle.body) as {
      error: { code: string; issues: readonly { code: string }[] };
    };
    expect(handlePayload.error.code).toBe("INVALID_INPUT");
    expect(handlePayload.error.issues[0]?.code).toBe("invalid_type");

    // Other JSON scalars are equally rejected, not silently dropped.
    for (const rawBody of ['"a string"', "42", "true", "null"]) {
      const response = await handler.fetch(
        jsonRequest("/prefs", { method: "PATCH", rawBody }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("keeps object and absent bodies working on object-schema routes", async () => {
    const handler = makeHandler();

    const withBody = await handler.fetch(
      jsonRequest("/prefs", { method: "PATCH", body: { title: "hello", count: 2 } }),
    );
    expect(withBody.status).toBe(200);
    const payload = (await withBody.json()) as { ok: boolean; value: { received: string } };
    expect(payload.ok).toBe(true);
    expect(JSON.parse(payload.value.received)).toEqual({ title: "hello", count: 2 });

    const withoutBody = await handler.fetch(jsonRequest("/prefs", { method: "PATCH" }));
    expect(withoutBody.status).toBe(200);
    await expect(withoutBody.json()).resolves.toEqual({
      ok: true,
      value: { received: "{}" },
    });
  });

  it("lets path params override query and body values", async () => {
    const handler = makeHandler({ authenticate });
    await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", body: { id: "keep", title: "Keep" } }),
    );

    const removed = await handler.fetch(
      jsonRequest("/notes/keep?id=other", { method: "DELETE" }),
    );
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ ok: true, value: { removed: true } });
  });
});

/* ------------------------------------------------------------------ */
/* Faults + onError                                                   */
/* ------------------------------------------------------------------ */

describe("faults", () => {
  it("answers opaque 500 and reports the fault to onError", async () => {
    const onError = vi.fn();
    const handler = makeHandler({ onError });
    const response = await handler.fetch(jsonRequest("/boom"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL" },
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "EFFECT_FAILURE" });
    expect(onError.mock.calls[0]?.[1]).toEqual({
      method: "GET",
      path: "/boom",
      operationId: "chaos.boom",
    });
  });

  it("maps invariant violations to opaque 500", async () => {
    const onError = vi.fn();
    const handler = makeHandler({ onError });
    const response = await handler.fetch(jsonRequest("/breach", { method: "POST" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL" },
    });
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "INVARIANT_VIOLATION" });
  });

  it("reports fetch-entry failures with the pathname and matched operationId", async () => {
    const onError = vi.fn();
    const handler = makeHandler({ onError });

    // Force a failure in the fetch entry itself (Response construction),
    // outside handle()'s own catch.
    const RealResponse = globalThis.Response;
    let constructions = 0;
    const ThrowingResponse = function (body: unknown, init: unknown) {
      constructions += 1;
      if (constructions === 1) throw new TypeError("simulated Response failure");
      return new RealResponse(body as BodyInit | null, init as ResponseInit);
    } as unknown as typeof Response;
    vi.stubGlobal("Response", ThrowingResponse);
    try {
      const response = await handler.fetch(jsonRequest("/notes/latest"));
      expect(response.status).toBe(500);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(onError).toHaveBeenCalledTimes(1);
    // Pathname (never the full URL) + the matched operation id.
    expect(onError.mock.calls[0]?.[1]).toEqual({
      method: "GET",
      path: "/notes/latest",
      operationId: "notes.latest",
    });
  });

  it("reports invalid request URLs to onError without crashing the fetch entry", async () => {
    const onError = vi.fn();
    const handler = makeHandler({ onError });
    const response = await handler.fetch({
      method: "GET",
      url: "not-a-url",
      headers: { get: () => null },
      body: null,
    } as unknown as Request);

    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toEqual({ method: "GET", path: "not-a-url" });
  });

  it("defaults onError to console.error in development mode only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const development = createHttpHandler(makeApp("development"));
    await development.fetch(jsonRequest("/boom"));
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    const production = createHttpHandler(makeApp("production"));
    const response = await production.fetch(jsonRequest("/boom"));
    expect(response.status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Overrides (defineHttpRoute escape hatch)                           */
/* ------------------------------------------------------------------ */

describe("route overrides", () => {
  it("replaces auto routes of overridden operations and applies custom mapping", async () => {
    const app = makeApp();
    const legacy = defineHttpRoute({
      method: "put",
      path: "/legacy/notes/:noteId",
      operation: app.operations["notes.create"],
      status: 200,
      mapRequest: ({ params, body }) => ({
        id: params["noteId"] ?? "",
        title:
          typeof body === "object" && body !== null && "title" in body
            ? String((body as { title: unknown }).title)
            : "",
      }),
    });
    const handler = createHttpHandler(app, { authenticate, routes: [legacy] });

    const created = await handler.fetch(
      jsonRequest("/legacy/notes/n9", { method: "PUT", token: "writer", body: { title: "Legacy" } }),
    );
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({
      ok: true,
      value: { id: "n9", title: "Legacy" },
    });

    // The auto POST /notes route is dropped for the overridden operation.
    const dropped = await handler.fetch(
      jsonRequest("/notes", { method: "POST", token: "writer", body: { id: "x", title: "T" } }),
    );
    expect(dropped.status).toBe(404);
  });

  it("keeps derived error statuses on overridden routes", async () => {
    const app = makeApp();
    const legacy = defineHttpRoute({
      method: "put",
      path: "/legacy/notes/:noteId",
      operation: app.operations["notes.create"],
      mapRequest: ({ params }) => ({ id: params["noteId"] ?? "", title: "same" }),
    });
    const handler = createHttpHandler(app, { authenticate, routes: [legacy] });

    const first = await handler.fetch(
      jsonRequest("/legacy/notes/dup", { method: "PUT", token: "writer" }),
    );
    expect(first.status).toBe(201); // no status override -> operation's http.status

    const conflict = await handler.fetch(
      jsonRequest("/legacy/notes/dup", { method: "PUT", token: "writer" }),
    );
    expect(conflict.status).toBe(409);
  });

  it("refuses descriptors that are not registered in the application", () => {
    const makeSolo = () =>
      feature("solo", {
        operations: {
          ping: query({
            input: s.object({}),
            output: s.object({}),
            http: { method: "GET", path: "/ping" },
            async execute() {
              return {};
            },
          }),
        },
      });
    const soloA = makeSolo();
    const soloB = makeSolo();
    const appA = createApplication({ features: [soloA], adapters: [], mode: "test" });

    expect(() =>
      createHttpHandler(appA, {
        routes: [
          defineHttpRoute({ method: "get", path: "/p2", operation: soloB.operations.ping }),
        ],
      }),
    ).toThrow(/registered descriptor/);

    expect(() =>
      createHttpHandler(makeApp(), {
        routes: [
          defineHttpRoute({ method: "get", path: "/p2", operation: soloA.operations.ping }),
        ],
      }),
    ).toThrow(/unknown operation/);
  });

  it("rejects statuses the JSON envelope cannot carry (204/205/304, 1xx)", () => {
    const app = makeApp();
    expect(() =>
      defineHttpRoute({
        method: "delete",
        path: "/legacy/notes/:noteId",
        operation: app.operations["notes.remove"],
        status: 204,
      }),
    ).toThrow(/Route status cannot be 204: 204, 205, and 304 forbid a response body/);
    expect(() =>
      defineHttpRoute({
        method: "get",
        path: "/legacy/notes/:noteId",
        operation: app.operations["notes.get"],
        status: 101,
      }),
    ).toThrow(/Route status must be an integer in 200\.\.599/);
    expect(() =>
      defineHttpRoute({
        method: "get",
        path: "/legacy/notes/:noteId",
        operation: app.operations["notes.get"],
        errorStatus: { NOTE_NOT_FOUND: 304 },
      }),
    ).toThrow(/Route errorStatus\[NOTE_NOT_FOUND\] cannot be 304/);
  });

  it("rejects invalid paths and duplicate route shapes", () => {
    const app = makeApp();
    expect(() =>
      defineHttpRoute({
        method: "get",
        path: "relative",
        operation: app.operations["notes.get"],
      }),
    ).toThrow(/must start/);

    const first = defineHttpRoute({
      method: "get",
      path: "/dup/:a",
      operation: app.operations["notes.get"],
    });
    const sameShape = defineHttpRoute({
      method: "get",
      path: "/dup/:b",
      operation: app.operations["notes.get"],
    });
    expect(() =>
      createHttpHandler(app, { routes: [first, sameShape] }),
    ).toThrow(/Duplicate HTTP route/);
  });
});
