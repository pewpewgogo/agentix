import {
  AuthenticationError,
  createBearerPrincipalExtractor,
  createHttpHandler,
  type HttpHandler,
} from "@agentix/adapters-http";
import {
  createApplication,
  type Application,
  type ApplicationOperations,
  type BoundPortAdapter,
  type Principal,
  type RuntimeMode,
} from "@agentix/core";

import { createPostgresNotesAdapter, createPostgresPool } from "./adapters/postgres.js";
import { NoteClock, notes } from "./features/notes.js";
import { createConsoleObserver, type LogLine } from "./observability.js";

export type PgNotesOperations = ApplicationOperations<[typeof notes]>;
export type PgNotesApplication = Application<PgNotesOperations>;

/* ------------------------------------------------------------------ */
/* Application                                                        */
/* ------------------------------------------------------------------ */

export interface PgNotesApplicationOptions {
  /** postgres:// connection string; the pool is created on app.start(). */
  readonly databaseUrl: string;
  /** Defaults from NODE_ENV like createApplication does. */
  readonly mode?: RuntimeMode;
  /** Structured log sink; defaults to console.log. */
  readonly log?: LogLine;
  /** Replace the persistence adapter (tests); default is PostgreSQL. */
  readonly noteStoreAdapter?: BoundPortAdapter;
}

export const createPgNotesApplication = (
  options: PgNotesApplicationOptions,
): PgNotesApplication =>
  createApplication({
    features: [notes],
    adapters: [
      options.noteStoreAdapter ??
        createPostgresNotesAdapter({
          createPool: () => createPostgresPool(options.databaseUrl),
        }),
      NoteClock.adapter({ now: () => new Date().toISOString() }),
    ],
    observer: createConsoleObserver(options.log),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });

/* ------------------------------------------------------------------ */
/* HTTP handler: bearer auth, health, CORS                            */
/* ------------------------------------------------------------------ */

/** Static token table for the demo. Real deployments resolve tokens against
 * a credential store or verify JWTs inside `resolve` instead. */
export const DEMO_TOKENS: Readonly<Record<string, Principal>> = {
  "writer-token": { id: "writer", permissions: ["notes:read", "notes:write"] },
  "reader-token": { id: "reader", permissions: ["notes:read"] },
};

export interface PgNotesHandlerOptions {
  /** Bearer token -> principal table; defaults to DEMO_TOKENS. */
  readonly tokens?: Readonly<Record<string, Principal>>;
  /** Browser origins allowed by CORS; omit to serve no CORS headers. */
  readonly corsOrigins?: readonly string[] | "*";
  /** Structured log sink for faults; defaults to console.error. */
  readonly logError?: LogLine;
}

export const createPgNotesHandler = (
  app: PgNotesApplication,
  options: PgNotesHandlerOptions = {},
): HttpHandler<PgNotesOperations> => {
  const tokens = options.tokens ?? DEMO_TOKENS;
  const logError =
    options.logError ??
    ((line: string) => {
      console.error(line);
    });
  return createHttpHandler(app, {
    authenticate: createBearerPrincipalExtractor({
      resolve: (token) => {
        const principal = tokens[token];
        // Unknown token is malformed credentials -> 401. (Returning null
        // would mean "anonymous", which downgrades the response to 403.)
        if (principal === undefined) {
          throw new AuthenticationError("Unknown bearer token.", "UNKNOWN_TOKEN");
        }
        return principal;
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
          ...(info.operationId === undefined
            ? {}
            : { operationId: info.operationId }),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });
};
