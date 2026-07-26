import { Agent, request as httpRequest } from "node:http";

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

beforeAll(async () => {
  const app = createApplication({
    features: [notes],
    adapters: [NoteStore.memory()],
    mode: "test",
  });
  const handler = createHttpHandler(app, {
    authenticate: createTrustedHeaderPrincipalExtractor(),
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
