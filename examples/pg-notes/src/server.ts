/**
 * Production-shaped entrypoint: real PostgreSQL, bearer auth, health path,
 * CORS, structured logs, and graceful shutdown on SIGTERM/SIGINT.
 *
 *   docker compose up -d
 *   npm run build && npm start
 */
import { serveNode } from "@agentixdev/adapters-http";

import { createPgNotesApplication, createPgNotesHandler } from "./application.js";

const env = process.env;

const databaseUrl =
  env["PG_NOTES_DATABASE_URL"] ??
  "postgres://notes:notes@127.0.0.1:55432/notes";

const app = createPgNotesApplication({ databaseUrl });
await app.start(); // pool created + schema bootstrapped here, before traffic

const handler = createPgNotesHandler(app, {
  corsOrigins: env["PG_NOTES_CORS_ORIGIN"] === undefined
    ? ["http://localhost:5173"]
    : [env["PG_NOTES_CORS_ORIGIN"]],
});

const server = await serveNode(handler, {
  port: Number(env["PORT"] ?? 3000),
  host: env["HOST"] ?? "127.0.0.1",
  maxBodyBytes: 256 * 1024,
  gracefulTimeoutMs: 10_000, // drain window for in-flight requests
  closeApplication: true, // after the drain, app.close() ends the pg pool
});

console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    msg: "server.listening",
    url: server.url,
    health: `${server.url}/healthz`,
  }),
);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    JSON.stringify({ at: new Date().toISOString(), msg: "server.draining", signal }),
  );
  // server.close(): stop accepting -> drain (<= gracefulTimeoutMs) ->
  // app.close() (dispose hooks end the pg pool).
  void server
    .close()
    .then(() => {
      console.log(
        JSON.stringify({ at: new Date().toISOString(), msg: "server.closed" }),
      );
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          msg: "server.close_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exitCode = 1;
    });
};

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  shutdown("SIGINT");
});
