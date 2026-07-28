/**
 * Production-shaped entrypoint: env validated up front, PostgreSQL (or
 * memory) persistence, toncenter chain watcher, webhook/Telegram/console
 * notifier, bearer auth, health path, a reconcile poller with an overlap
 * guard, and graceful shutdown on SIGTERM/SIGINT.
 *
 *   docker compose up -d
 *   RECEIVE_ADDRESS=... ADMIN_TOKEN=... npm start
 */
import { serveNode } from "@agentixdev/adapters-http";
import { principal } from "@agentixdev/core";

import { createTelegramNotifier, createWebhookNotifier } from "./adapters/notify.js";
import { createToncenterChainWatcher } from "./adapters/toncenter.js";
import {
  ADMIN_PERMISSIONS,
  createReconcilePoller,
  createTonInvoicesApplication,
  createTonInvoicesHandler,
} from "./app.js";

/* ------------------------------------------------------------------ */
/* Environment validation (fail fast, all problems at once)           */
/* ------------------------------------------------------------------ */

const env = process.env;
const problems: string[] = [];

const requireEnv = (name: string, hint: string): string => {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    problems.push(`${name} is required: ${hint}`);
    return "";
  }
  return value.trim();
};

const intEnv = (name: string, fallback: number, min = 1): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    problems.push(`${name} must be an integer >= ${min}, got '${raw}'`);
    return fallback;
  }
  return value;
};

const receiveAddress = requireEnv(
  "RECEIVE_ADDRESS",
  "the TON address invoices are payable to (goes into every ton:// link)",
);
const adminToken = requireEnv(
  "ADMIN_TOKEN",
  "the bearer token granting invoices:create/read/cancel/reconcile",
);
const invoiceTtlMs = intEnv("INVOICE_TTL_MS", 15 * 60 * 1000);
const pollMs = intEnv("POLL_MS", 10_000);
/** How far past expiry an ON-CHAIN payment time still settles (0 = exact). */
const expiryGraceMs = intEnv("EXPIRY_GRACE_MS", 0, 0);
const databaseUrl = env["DATABASE_URL"]; // optional -> in-memory persistence

const webhookUrl = env["NOTIFY_WEBHOOK_URL"];
const telegramToken = env["TELEGRAM_BOT_TOKEN"];
const telegramChatId = env["TELEGRAM_CHAT_ID"];
if ((telegramToken === undefined) !== (telegramChatId === undefined)) {
  problems.push("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together");
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(JSON.stringify({ at: new Date().toISOString(), msg: "config.invalid", problem }));
  }
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Assembly                                                           */
/* ------------------------------------------------------------------ */

const notifierAdapter =
  webhookUrl !== undefined
    ? createWebhookNotifier({ url: webhookUrl })
    : telegramToken !== undefined && telegramChatId !== undefined
      ? createTelegramNotifier({ botToken: telegramToken, chatId: telegramChatId })
      : undefined; // console notifier (default inside the assembly)

const app = createTonInvoicesApplication({
  receiveAddress,
  invoiceTtlMs,
  expiryGraceMs,
  databaseUrl,
  chainWatcherAdapter: createToncenterChainWatcher({
    address: receiveAddress,
    ...(env["TONCENTER_API_KEY"] === undefined ? {} : { apiKey: env["TONCENTER_API_KEY"] }),
    ...(env["TONCENTER_ENDPOINT"] === undefined ? {} : { endpoint: env["TONCENTER_ENDPOINT"] }),
  }),
  ...(notifierAdapter === undefined ? {} : { notifierAdapter }),
});
await app.start(); // pg pool created + schema bootstrapped here, before traffic

const handler = createTonInvoicesHandler(app, {
  tokens: { [adminToken]: principal("admin", [...ADMIN_PERMISSIONS]) },
  // CORS stays off unless an origin is explicitly allowed.
  ...(env["CORS_ORIGIN"] === undefined ? {} : { corsOrigins: [env["CORS_ORIGIN"]] }),
});

const server = await serveNode(handler, {
  port: Number(env["PORT"] ?? 3000),
  host: env["HOST"] ?? "127.0.0.1",
  maxBodyBytes: 64 * 1024,
  gracefulTimeoutMs: 10_000,
  closeApplication: true, // after the drain, app.close() ends the pg pool
});

console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    msg: "server.listening",
    url: server.url,
    health: `${server.url}/healthz`,
    persistence: databaseUrl === undefined ? "memory" : "postgres",
    pollMs,
  }),
);

/* ------------------------------------------------------------------ */
/* Reconcile poller (assembly-level, not domain)                      */
/*                                                                    */
/* Overlap-guarded interval over invoices.reconcile; logs completed   */
/* runs, quarantined (malformed) transactions with their parser path, */
/* failures with the underlying effect cause, and a reconcile.stalled */
/* alert after consecutive failures — a stalled cursor means no       */
/* payment is being credited, which must page someone.                */
/* ------------------------------------------------------------------ */

const poller = createReconcilePoller(app, { pollMs });
poller.start();

/* ------------------------------------------------------------------ */
/* Graceful shutdown                                                  */
/* ------------------------------------------------------------------ */

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  poller.stop();
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
