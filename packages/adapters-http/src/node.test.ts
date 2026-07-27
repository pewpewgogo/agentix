import { Agent, request as httpRequest } from "node:http";
import type { ServerResponse } from "node:http";
import { createConnection } from "node:net";
import type { Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { command, createApplication, feature, port, query, s } from "@agentix/core";

import { createTrustedHeaderPrincipalExtractor } from "./auth.js";
import { createHttpHandler } from "./handler.js";
import { serveNode } from "./node.js";
import type { NodeHttpServer } from "./node.js";

const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
});

const NoteStore = port.store("nodeNoteStore", Note);

const executions = { create: 0 };

const notes = feature("nodenotes", {
  operations: {
    create: command({
      input: Note,
      output: Note,
      errors: { NOTE_EXISTS: { http: 409, details: { id: s.string() } } },
      permissions: ["notes:write"],
      http: { method: "POST", path: "/notes", status: 201 },
      effects: { load: NoteStore.get, save: NoteStore.save },
      async execute({ input, effects, fail }) {
        executions.create += 1;
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
  },
});

const writerHeaders = {
  "content-type": "application/json",
  "x-principal-id": "writer",
  "x-principal-permissions": "notes:write",
};

let handle: NodeHttpServer;
let connections = 0;

const openRawSocket = async (): Promise<Socket> => {
  const url = new URL(handle.url);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.on("error", () => {}); // teardown races (ECONNRESET/EPIPE) are expected
  return socket;
};

beforeAll(async () => {
  const app = createApplication({
    features: [notes],
    adapters: [NoteStore.memory()],
    mode: "test",
  });
  const handler = createHttpHandler(app, {
    authenticate: createTrustedHeaderPrincipalExtractor(),
    health: "/healthz",
    cors: { origins: ["https://app.example"] },
  });
  handle = await serveNode(handler, { port: 0, maxBodyBytes: 4096 });
  handle.server.on("connection", () => {
    connections += 1;
  });
});

afterAll(async () => {
  await handle.close();
});

describe("serveNode", () => {
  it("resolves once listening with a fetchable loopback url", () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it("serves the full envelope over real sockets", async () => {
    const created = await fetch(`${handle.url}/notes`, {
      method: "POST",
      headers: writerHeaders,
      body: JSON.stringify({ id: "n1", title: "First" }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(created.json()).resolves.toEqual({
      ok: true,
      value: { id: "n1", title: "First" },
    });

    const conflict = await fetch(`${handle.url}/notes`, {
      method: "POST",
      headers: writerHeaders,
      body: JSON.stringify({ id: "n1", title: "Again" }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOTE_EXISTS", details: { id: "n1" } },
    });

    const found = await fetch(`${handle.url}/notes/n1`);
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toEqual({
      ok: true,
      value: { id: "n1", title: "First" },
    });
  });

  it("decodes percent-encoded params on the raw path", async () => {
    const missing = await fetch(`${handle.url}/notes/a%20b`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOTE_NOT_FOUND", details: { id: "a b" } },
    });
  });

  it("answers 404 for unknown routes and 405 with Allow", async () => {
    const missing = await fetch(`${handle.url}/nowhere`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    const wrongMethod = await fetch(`${handle.url}/notes`, { method: "PUT" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    await expect(wrongMethod.json()).resolves.toEqual({
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED" },
    });
  });

  it("answers 403 before reading malformed bodies on the raw path", async () => {
    const before = executions.create;
    const response = await fetch(`${handle.url}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(executions.create).toBe(before);
  });

  it("caps request bodies at maxBodyBytes with 413", async () => {
    const response = await fetch(`${handle.url}/notes`, {
      method: "POST",
      headers: writerHeaders,
      body: JSON.stringify({ id: "big", title: "x".repeat(5000) }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("closes the connection after a mid-stream over-cap 413 so stale bytes are never reused", async () => {
    const socket = await openRawSocket();
    const piece = "x".repeat(3000);
    const chunk = `${(3000).toString(16)}\r\n${piece}\r\n`;
    // Chunked body streams past maxBodyBytes (2 x 3000 > 4096) mid-request.
    socket.write(
      "POST /notes HTTP/1.1\r\n" +
        `host: ${new URL(handle.url).host}\r\n` +
        "content-type: application/json\r\n" +
        "x-principal-id: writer\r\n" +
        "x-principal-permissions: notes:write\r\n" +
        "transfer-encoding: chunked\r\n" +
        "\r\n" +
        chunk +
        chunk,
    );
    // Pipeline a second request behind the (unterminated) over-cap body: if
    // the connection survived, these bytes could be misread as a request.
    socket.write(`GET /notes/n1 HTTP/1.1\r\nhost: ${new URL(handle.url).host}\r\n\r\n`);

    let data = "";
    socket.on("data", (buffer) => {
      data += buffer.toString("utf8");
    });
    const outcome = await Promise.race([
      new Promise<string>((resolve) => socket.once("close", () => resolve("closed"))),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("still-open"), 2000);
        socket.once("close", () => clearTimeout(timer));
      }),
    ]);

    // The server must tear the socket down promptly (no keep-alive limbo
    // that stalls close() for the whole keepAliveTimeout).
    expect(outcome).toBe("closed");
    expect(data).toContain(" 413 ");
    expect(data.toLowerCase()).toContain("connection: close");
    // The pipelined request is never answered from stale bytes.
    expect(data.match(/HTTP\/1\.1 /g)).toHaveLength(1);
    socket.destroy();
  });

  it("keeps the connection reusable after a declared content-length 413", async () => {
    const socket = await openRawSocket();
    const host = new URL(handle.url).host;
    const oversized = JSON.stringify({ id: "big", title: "x".repeat(5000) });
    // The cap trips on the declared content-length BEFORE the body is read:
    // the parser stays in sync, so pipelining keeps working.
    socket.write(
      "POST /notes HTTP/1.1\r\n" +
        `host: ${host}\r\n` +
        "content-type: application/json\r\n" +
        "x-principal-id: writer\r\n" +
        "x-principal-permissions: notes:write\r\n" +
        `content-length: ${Buffer.byteLength(oversized)}\r\n` +
        "\r\n" +
        oversized,
    );
    socket.write(`GET /notes/n1 HTTP/1.1\r\nhost: ${host}\r\n\r\n`);

    let data = "";
    const twoResponses = new Promise<string>((resolve) => {
      socket.on("data", (buffer) => {
        data += buffer.toString("utf8");
        if ((data.match(/HTTP\/1\.1 /g) ?? []).length >= 2) resolve("two-responses");
      });
    });
    const outcome = await Promise.race([
      twoResponses,
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 2000);
        socket.once("close", () => clearTimeout(timer));
      }),
    ]);

    expect(outcome).toBe("two-responses");
    const statuses = [...data.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => match[1]);
    expect(statuses[0]).toBe("413");
    expect(statuses[1]).toBe("200");
    socket.destroy();
  });

  it("reuses keep-alive connections across sequential requests", async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const requestOnce = (path: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const request = httpRequest(`${handle.url}${path}`, { agent }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        });
        request.on("error", reject);
        request.end();
      });

    const before = connections;
    const first = await requestOnce("/notes/n1");
    const second = await requestOnce("/notes/n1");
    expect(first).toBe(200);
    expect(second).toBe(200);
    expect(connections - before).toBe(1);
    agent.destroy();
  });
});

/* ------------------------------------------------------------------ */
/* Request id, health, CORS over real sockets                         */
/* ------------------------------------------------------------------ */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("serveNode request id + health + CORS", () => {
  it("echoes inbound x-request-id and generates one when absent", async () => {
    const echoed = await fetch(`${handle.url}/notes/absent`, {
      headers: { "x-request-id": "node-req-1" },
    });
    expect(echoed.status).toBe(404);
    expect(echoed.headers.get("x-request-id")).toBe("node-req-1");

    const generated = await fetch(`${handle.url}/nowhere`);
    expect(generated.status).toBe(404);
    expect(generated.headers.get("x-request-id")).toMatch(UUID_PATTERN);

    const invalid = await fetch(`${handle.url}/nowhere`, {
      headers: { "x-request-id": "not a valid header value!" },
    });
    expect(invalid.headers.get("x-request-id")).toMatch(UUID_PATTERN);
  });

  it("serves health without principal headers", async () => {
    const response = await fetch(`${handle.url}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-request-id")).toMatch(UUID_PATTERN);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("answers preflight 204 with no body and no content headers", async () => {
    const response = await fetch(`${handle.url}/notes`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(response.headers.get("x-request-id")).toMatch(UUID_PATTERN);
    await expect(response.text()).resolves.toBe("");

    // The connection state stays coherent: a follow-up request works.
    const followUp = await fetch(`${handle.url}/healthz`);
    expect(followUp.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Graceful shutdown + abort wiring                                   */
/* ------------------------------------------------------------------ */

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met within the timeout");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

const makeGracefulFixture = (behavior: "gate" | "abort" = "gate") => {
  const Slow = port("slowPort", {
    read: port.read({ input: s.object({}), output: s.object({ done: s.boolean() }) }),
  });
  const slow = feature("slow", {
    operations: {
      wait: query({
        input: s.object({}),
        output: s.object({ done: s.boolean() }),
        http: { method: "GET", path: "/slow" },
        effects: { read: Slow.read },
        async execute({ effects }) {
          return effects.read({});
        },
      }),
    },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const settled: { kind: string; code?: string }[] = [];
  let disposeCount = 0;
  const app = createApplication({
    features: [slow],
    adapters: [
      Slow.adapter(
        {
          read: (_input, { signal }) => {
            entered();
            if (behavior === "abort") {
              // Settles only when the dispatch signal aborts (client gone).
              return new Promise((resolve) => {
                signal.addEventListener("abort", () => resolve({ done: false }), {
                  once: true,
                });
              });
            }
            return gate.then(() => ({ done: true }));
          },
        },
        {
          dispose: () => {
            disposeCount += 1;
          },
        },
      ),
    ],
    mode: "test",
    observer: {
      dispatchSettled(ctx) {
        settled.push({
          kind: ctx.kind,
          ...(ctx.code === undefined ? {} : { code: ctx.code }),
        });
      },
    },
  });
  return {
    handler: createHttpHandler(app),
    app,
    enteredPromise,
    release,
    settled,
    disposed: () => disposeCount,
  };
};

describe("serveNode graceful shutdown", () => {
  it("waits for in-flight requests, then refuses new connections", async () => {
    const fixture = makeGracefulFixture();
    const server = await serveNode(fixture.handler, {
      port: 0,
      gracefulTimeoutMs: 5000,
    });

    const pending = fetch(`${server.url}/slow`);
    await fixture.enteredPromise;
    const closing = server.close();
    fixture.release();

    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      value: { done: true },
    });
    await closing;

    await expect(fetch(`${server.url}/slow`)).rejects.toThrow();
    // Idempotent: repeat close() resolves without error.
    await server.close();
  });

  it("destroys sockets still in flight once the graceful timeout expires", async () => {
    const fixture = makeGracefulFixture();
    const server = await serveNode(fixture.handler, {
      port: 0,
      gracefulTimeoutMs: 100,
    });

    const pending = fetch(`${server.url}/slow`); // never released before close
    await fixture.enteredPromise;
    const closing = server.close();

    await expect(pending).rejects.toThrow(); // socket torn down at the timeout
    await closing;
    fixture.release(); // let the still-pending dispatch settle (cleanup)
  });

  it("closeApplication disposes adapters after the drain", async () => {
    const fixture = makeGracefulFixture();
    const server = await serveNode(fixture.handler, {
      port: 0,
      gracefulTimeoutMs: 1000,
      closeApplication: true,
    });

    fixture.release(); // fast request: nothing in flight at close time
    const ok = await fetch(`${server.url}/slow`);
    expect(ok.status).toBe(200);
    expect(fixture.disposed()).toBe(0);

    await server.close();
    expect(fixture.disposed()).toBe(1);

    const afterClose = await fixture.app.dispatch("slow.wait", { input: {} });
    expect(afterClose).toMatchObject({
      kind: "fault",
      error: { code: "APPLICATION_CLOSED" },
    });
  });

  it("aborts dispatch and never writes when the client disconnects mid-dispatch", async () => {
    const fixture = makeGracefulFixture("abort");
    const server = await serveNode(fixture.handler, { port: 0 });
    let captured: ServerResponse | undefined;
    server.server.on("request", (_request, response) => {
      captured = response;
    });

    const url = new URL(server.url);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    let received = "";
    socket.on("data", (buffer) => {
      received += buffer.toString("utf8");
    });
    socket.write(`GET /slow HTTP/1.1\r\nhost: ${url.host}\r\n\r\n`);

    await fixture.enteredPromise;
    socket.destroy(); // client goes away mid-dispatch

    await waitUntil(() =>
      fixture.settled.some(
        (entry) => entry.kind === "fault" && entry.code === "DISPATCH_ABORTED",
      ),
    );
    expect(fixture.settled).toEqual([{ kind: "fault", code: "DISPATCH_ABORTED" }]);
    // Nothing was written to the closed socket: no status line ever arrived
    // and the server never sent headers.
    expect(received).toBe("");
    expect(captured?.headersSent).toBe(false);

    await server.close();
  });
});
