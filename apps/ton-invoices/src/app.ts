/**
 * Assembly: application wiring (adapters, observer, subscribers) and the
 * HTTP handler (bearer auth, health). Domain rules live in
 * src/features/invoices.ts; this file only binds capabilities.
 */
import { createHash } from "node:crypto";

import {
  AuthenticationError,
  createBearerPrincipalExtractor,
  createHttpHandler,
  type HttpHandler,
} from "@agentixdev/adapters-http";
import {
  createApplication,
  DispatchError,
  principal,
  subscription,
  type Application,
  type ApplicationOperations,
  type BoundPortAdapter,
  type DispatchObserver,
  type Principal,
  type RuntimeMode,
} from "@agentixdev/core";

import {
  createConsoleNotifier,
  createMemoryChainWatcher,
  createMemoryInvoiceStore,
} from "./adapters/memory.js";
import {
  createPostgresInvoiceStoreAdapter,
  createPostgresPool,
} from "./adapters/postgres.js";
import {
  InvoiceClock,
  InvoiceConfig,
  InvoiceIds,
  InvoicePaid,
  invoices,
  type InvoicePaidPayload,
} from "./features/invoices.js";

export type TonInvoicesOperations = ApplicationOperations<[typeof invoices]>;
export type TonInvoicesApplication = Application<TonInvoicesOperations>;

/* ------------------------------------------------------------------ */
/* Principals                                                         */
/* ------------------------------------------------------------------ */

export const ADMIN_PERMISSIONS = [
  "invoices:create",
  "invoices:read",
  "invoices:cancel",
  "invoices:reconcile",
] as const;

/** The invoice.paid subscriber dispatches invoices.notifyPaid as this. */
export const NOTIFY_PRINCIPAL: Principal = principal("invoice-paid-subscriber", [
  "invoices:notify",
]);

/** The server-side poller calls invoices.reconcile as this. */
export const POLLER_PRINCIPAL: Principal = principal("reconcile-poller", [
  "invoices:reconcile",
]);

/* ------------------------------------------------------------------ */
/* Observability: console JSON with requestId correlation             */
/* ------------------------------------------------------------------ */

export type LogLine = (line: string) => void;

const millis = (durationNs: bigint): number => Number(durationNs / 1000n) / 1000;

const requestIdOf = (meta: unknown): string | undefined => {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)["requestId"];
  return typeof value === "string" ? value : undefined;
};

/**
 * Structured JSON logs from the dispatch lifecycle. The HTTP adapter passes
 * `meta: { requestId }` on every dispatch, so each line correlates with the
 * `x-request-id` response header of the request that caused it. Poller
 * dispatches carry no requestId and simply omit the field.
 */
export const createConsoleObserver = (
  log: LogLine = (line) => {
    console.log(line);
  },
): DispatchObserver => ({
  dispatchSettled({ operationId, kind, code, durationNs, meta }) {
    const requestId = requestIdOf(meta);
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        msg: "dispatch.settled",
        operationId,
        kind,
        ...(code === undefined ? {} : { code }),
        durationMs: millis(durationNs),
        ...(requestId === undefined ? {} : { requestId }),
      }),
    );
  },
  effectSettled({ operationId, effectId, ok, durationNs }) {
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        msg: "effect.settled",
        operationId,
        effectId,
        ok,
        durationMs: millis(durationNs),
      }),
    );
  },
  subscriberFailed({ operationId, eventId, error }) {
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        msg: "subscriber.failed",
        operationId,
        eventId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  },
});

/* ------------------------------------------------------------------ */
/* Application                                                        */
/* ------------------------------------------------------------------ */

export interface TonInvoicesApplicationOptions {
  /** The TON address invoices are payable to (goes into every ton:// link). */
  readonly receiveAddress: string;
  /** How long a new invoice stays payable, in milliseconds. */
  readonly invoiceTtlMs: number;
  /**
   * Extra slack past an invoice's expiry within which a payment's ON-CHAIN
   * time still settles it (clock skew between the chain and this host).
   * Default 0 — exact expiry.
   */
  readonly expiryGraceMs?: number | undefined;
  /** postgres:// connection string; omitted -> in-memory persistence. */
  readonly databaseUrl?: string | undefined;
  /** Defaults from NODE_ENV like createApplication does. */
  readonly mode?: RuntimeMode;
  /** Structured log sink; defaults to console.log. */
  readonly log?: LogLine;
  /** Replace the persistence adapter (tests). */
  readonly invoiceStoreAdapter?: BoundPortAdapter;
  /** Chain source; default is an EMPTY memory watcher — the server passes toncenter. */
  readonly chainWatcherAdapter?: BoundPortAdapter;
  /** invoice.paid sink; default logs a JSON line. */
  readonly notifierAdapter?: BoundPortAdapter;
}

export const createTonInvoicesApplication = (
  options: TonInvoicesApplicationOptions,
): TonInvoicesApplication => {
  const databaseUrl = options.databaseUrl;
  const invoiceStore =
    options.invoiceStoreAdapter ??
    (databaseUrl === undefined
      ? createMemoryInvoiceStore().adapter
      : createPostgresInvoiceStoreAdapter({
          createPool: () => createPostgresPool(databaseUrl),
        }));

  // invoice.paid -> invoices.notifyPaid -> InvoiceNotifier.send. Dispatching
  // an internal command (instead of calling the adapter directly) keeps the
  // notifier a real external port: validated payload, declared 5 s timeout,
  // observable effect. `notify` is late-bound because the subscriber list is
  // part of createApplication's definition; it only runs after `app` exists.
  let notify: (payload: InvoicePaidPayload) => Promise<void> = async () => undefined;

  const app: TonInvoicesApplication = createApplication({
    features: [invoices],
    adapters: [
      invoiceStore,
      options.chainWatcherAdapter ?? createMemoryChainWatcher().adapter,
      options.notifierAdapter ?? createConsoleNotifier(options.log),
      InvoiceConfig.adapter({
        get: () => ({
          receiveAddress: options.receiveAddress,
          ttlMs: options.invoiceTtlMs,
          expiryGraceMs: options.expiryGraceMs ?? 0,
        }),
      }),
      InvoiceClock.adapter({
        now: () => new Date().toISOString(),
        plusMs: ({ iso, ms }) => new Date(Date.parse(iso) + ms).toISOString(),
      }),
      InvoiceIds.adapter({
        invoiceId: () => crypto.randomUUID(),
        // URL-safe tag for the transfer comment. Full 128 bits: the comment is
        // UNIQUE in the store and the reconcile matches by it, so a collision
        // would fail the later create — keep the probability negligible.
        commentTag: () => `inv-${crypto.randomUUID().replaceAll("-", "")}`,
      }),
    ],
    subscribers: [subscription(InvoicePaid, async (payload) => notify(payload))],
    observer: createConsoleObserver(options.log),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });

  notify = async (payload) => {
    const result = await app.dispatch("invoices.notifyPaid", {
      input: payload,
      principal: NOTIFY_PRINCIPAL,
    });
    if (result.kind !== "completed") {
      // Throwing here routes the failure to observer.subscriberFailed; the
      // paying dispatch itself stays completed (delivery is best-effort).
      throw new Error(
        `invoice.paid notification dispatch ${result.kind}: ${result.error.code}`,
      );
    }
  };

  return app;
};

/* ------------------------------------------------------------------ */
/* HTTP handler: bearer auth, health; CORS OFF by default             */
/* ------------------------------------------------------------------ */

export interface TonInvoicesHandlerOptions {
  /** Bearer token -> principal table (built from env in server.ts). */
  readonly tokens: Readonly<Record<string, Principal>>;
  /** Browser origins allowed by CORS; omitted -> no CORS headers at all. */
  readonly corsOrigins?: readonly string[] | "*";
  /** Structured log sink for faults; defaults to console.error. */
  readonly logError?: LogLine;
}

/** SHA-256 of the token, so lookups compare fixed-length digests instead of
 * the secret itself (no early-exit on a partially-right token). */
const tokenDigest = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const createTonInvoicesHandler = (
  app: TonInvoicesApplication,
  options: TonInvoicesHandlerOptions,
): HttpHandler<TonInvoicesOperations> => {
  const logError =
    options.logError ??
    ((line: string) => {
      console.error(line);
    });
  // A Map keyed by token DIGEST, never a plain-object index: `tokens[token]`
  // with an attacker-controlled token resolves Object.prototype members
  // ("toString", "__proto__", ...) to truthy non-Principal garbage, skipping
  // the 401 path. Object.entries only reads own enumerable keys.
  const principalsByDigest = new Map<string, Principal>(
    Object.entries(options.tokens).map(([token, resolved]) => [
      tokenDigest(token),
      resolved,
    ]),
  );
  return createHttpHandler(app, {
    authenticate: createBearerPrincipalExtractor({
      resolve: (token) => {
        const resolved = principalsByDigest.get(tokenDigest(token));
        // Unknown token is malformed credentials -> 401. (Returning null
        // would mean "anonymous", which downgrades the response to 403.)
        if (resolved === undefined) {
          throw new AuthenticationError("Unknown bearer token.", "UNKNOWN_TOKEN");
        }
        return resolved;
      },
    }),
    health: "/healthz",
    ...(options.corsOrigins === undefined
      ? {}
      : {
          cors: {
            origins: options.corsOrigins,
            credentials: false,
            maxAgeSeconds: 600,
          },
        }),
    onError: (error, info) => {
      logError(
        JSON.stringify({
          at: new Date().toISOString(),
          msg: "http.fault",
          method: info.method,
          path: info.path,
          requestId: info.requestId,
          ...(info.operationId === undefined ? {} : { operationId: info.operationId }),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });
};

/* ------------------------------------------------------------------ */
/* Reconcile poller (assembly-level, not domain)                      */
/* ------------------------------------------------------------------ */

export interface ReconcilePollerOptions {
  /** Poll interval in milliseconds. */
  readonly pollMs: number;
  /** Structured log sink; defaults to console.log. */
  readonly log?: LogLine;
  /** Error log sink; defaults to console.error. */
  readonly logError?: LogLine;
  /**
   * After this many CONSECUTIVE failed ticks a `reconcile.stalled` line is
   * emitted (and repeated each further failure): the cursor is not advancing,
   * so no payment is being credited — page someone. Default 3.
   */
  readonly alertAfterFailures?: number;
}

export interface ReconcilePoller {
  /** One reconcile pass (overlap-guarded); the interval calls this. Exposed
   * so hosts/tests can force a pass without waiting for the timer. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

/** Extracts the effect-level cause behind a DispatchError so the operator log
 * names the real failure (e.g. the toncenter parser's `$.transactions[i]`
 * path), not just "Dispatch fault: EFFECT_FAILURE". */
const dispatchErrorDetail = (
  error: unknown,
): { error: string; code?: string; effectId?: string; cause?: string } => {
  if (error instanceof DispatchError) {
    const detail = error.detail;
    const cause = "cause" in detail ? detail.cause : undefined;
    return {
      error: error.message,
      code: error.code,
      ...("effectId" in detail && typeof detail.effectId === "string"
        ? { effectId: detail.effectId }
        : {}),
      ...(cause === undefined
        ? {}
        : { cause: cause instanceof Error ? cause.message : String(cause) }),
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
};

export const createReconcilePoller = (
  app: TonInvoicesApplication,
  options: ReconcilePollerOptions,
): ReconcilePoller => {
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });
  const logError =
    options.logError ??
    ((line: string) => {
      console.error(line);
    });
  const alertAfter = options.alertAfterFailures ?? 3;

  let reconciling = false; // overlap guard: never two reconciles in flight
  let consecutiveFailures = 0;
  let interval: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try {
      const outcome = await app.call(
        "invoices.reconcile",
        {},
        { principal: POLLER_PRINCIPAL },
      );
      consecutiveFailures = 0;
      if (!outcome.ok) return; // reconcile declares no domain errors
      const { expired, paid, unattributed, malformed, transfersSeen, cursor } =
        outcome.value;
      if (expired.length > 0 || paid.length > 0 || transfersSeen > 0) {
        log(
          JSON.stringify({
            at: new Date().toISOString(),
            msg: "reconcile.completed",
            expired: expired.length,
            paid: paid.length,
            unattributed: unattributed.length,
            transfersSeen,
            cursor,
          }),
        );
      }
      // Quarantined transactions the watcher could not parse: loud, with the
      // path + tx hash, every poll they keep appearing.
      if (malformed.length > 0) {
        logError(
          JSON.stringify({
            at: new Date().toISOString(),
            msg: "reconcile.malformed_transactions",
            count: malformed.length,
            entries: malformed,
          }),
        );
      }
    } catch (error: unknown) {
      // DispatchError on rejected/fault (e.g. toncenter down). Log with the
      // underlying effect cause and let the next tick retry; the cursor
      // guarantees nothing is skipped.
      consecutiveFailures += 1;
      logError(
        JSON.stringify({
          at: new Date().toISOString(),
          msg: "reconcile.failed",
          consecutiveFailures,
          ...dispatchErrorDetail(error),
        }),
      );
      if (consecutiveFailures >= alertAfter) {
        logError(
          JSON.stringify({
            at: new Date().toISOString(),
            msg: "reconcile.stalled",
            consecutiveFailures,
            hint: "the watcher cursor is not advancing and no payment is being credited; check toncenter availability and the reconcile.failed causes above",
          }),
        );
      }
    } finally {
      reconciling = false;
    }
  };

  return {
    tick,
    start: () => {
      interval ??= setInterval(() => {
        void tick();
      }, options.pollMs);
    },
    stop: () => {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
    },
  };
};
