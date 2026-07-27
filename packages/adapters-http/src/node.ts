import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  INTERNAL_ERROR_BODY,
  JSON_CONTENT_TYPE,
  RESPONSE_BODY_CONSTANTS,
  RequestBodyLimitError,
} from "./handler.js";
import type { HandlerRequest, HandlerResponse, HttpHandler } from "./handler.js";

export interface ServeNodeOptions {
  /** Pass 0 for an ephemeral port; the resolved url reflects the real one. */
  readonly port: number;
  /** Defaults to 127.0.0.1. */
  readonly host?: string;
  /** Body byte cap; defaults to one mebibyte. Exceeding it answers 413. */
  readonly maxBodyBytes?: number;
  /**
   * Grace window close() gives in-flight requests before the remaining
   * sockets are destroyed. Defaults to 10 000 ms; 0 destroys immediately.
   */
  readonly gracefulTimeoutMs?: number;
  /** When true, close() awaits `handler.app.close()` after the drain. */
  readonly closeApplication?: boolean;
}

export interface NodeHttpServer {
  readonly server: Server;
  readonly url: string;
  /**
   * Graceful shutdown: stops accepting, destroys idle keep-alive
   * connections, waits for in-flight requests up to gracefulTimeoutMs, then
   * destroys whatever is left. Idempotent — repeat calls return the same
   * promise. With closeApplication, awaits app.close() after the drain.
   */
  readonly close: () => Promise<void>;
}

/** Constant envelopes pre-encoded once; dynamic bodies encode per response. */
const CONSTANT_PAYLOADS: ReadonlyMap<string, Buffer> = new Map(
  RESPONSE_BODY_CONSTANTS.map((body) => [body, Buffer.from(body, "utf8")]),
);

const headerValue = (
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined => {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
};

const readRequestBody = async (
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<string | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBodyBytes) {
      throw new RequestBodyLimitError();
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.byteLength;
    if (total > maxBodyBytes) throw new RequestBodyLimitError();
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  const first = chunks[0];
  return chunks.length === 1 && first !== undefined
    ? first.toString("utf8")
    : Buffer.concat(chunks, total).toString("utf8");
};

const writeOutcome = (response: ServerResponse, outcome: HandlerResponse): void => {
  if (outcome.status === 204) {
    // CORS preflight only: 204 forbids a body, so no content headers either.
    response.writeHead(204, { ...outcome.headers });
    response.end();
    return;
  }
  const payload = CONSTANT_PAYLOADS.get(outcome.body) ?? Buffer.from(outcome.body, "utf8");
  const headers: Record<string, string | number> = {
    "content-type": JSON_CONTENT_TYPE,
    "content-length": payload.byteLength,
  };
  if (outcome.headers !== undefined) {
    for (const name of Object.keys(outcome.headers)) {
      const value = outcome.headers[name];
      if (value !== undefined) headers[name] = value;
    }
  }
  response.writeHead(outcome.status, headers);
  response.end(payload);
};

const handleRaw = async (
  handler: HttpHandler,
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
  isClosing: () => boolean,
): Promise<void> => {
  // Per-request abort wiring: the controller aborts when the client socket
  // closes before the response finished; its signal reaches dispatch.
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  let outcome: HandlerResponse;
  try {
    const target = request.url ?? "/";
    const queryIndex = target.indexOf("?");
    const raw: HandlerRequest = {
      method: request.method ?? "GET",
      path: queryIndex === -1 ? target : target.slice(0, queryIndex),
      query: queryIndex === -1 ? "" : target.slice(queryIndex + 1),
      headers: (name) => headerValue(request.headers, name),
      readBody: () => readRequestBody(request, maxBodyBytes),
      signal: controller.signal,
    };
    outcome = await handler.handle(raw);
  } catch {
    outcome = { status: 500, body: INTERNAL_ERROR_BODY };
  }
  // Aborted requests never write: the client is gone, so any bytes would hit
  // a dead socket (and the envelope for an aborted dispatch is meaningless).
  if (controller.signal.aborted || response.destroyed || response.writableEnded) {
    response.destroy();
    return;
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }
  // A body read that aborted mid-stream (over-cap chunked upload, client
  // abort) leaves unread bytes on the wire that cannot be attributed to
  // request boundaries. Answer, then tear the connection down so keep-alive
  // reuse can never read stale body bytes as a new pipelined request.
  const truncated =
    !request.complete && (request.destroyed || request.errored !== null);
  if (truncated || isClosing()) {
    // While close() drains, finished responses must not linger on keep-alive
    // sockets — the connection is announced closed and destroyed on flush.
    response.setHeader("connection", "close");
    response.once("finish", () => response.destroy());
  }
  writeOutcome(response, outcome);
};

const urlHost = (address: AddressInfo): string => {
  if (address.address === "0.0.0.0") return "127.0.0.1";
  if (address.address === "::" || address.address === "::1") return "[::1]";
  return address.family === "IPv6" ? `[${address.address}]` : address.address;
};

/**
 * RAW req/res Node host over handler.handle(): no undici Request/Response
 * construction on the hot path, single-copy body reads, pre-encoded constant
 * envelopes, per-response precomputed status + content-length headers.
 * Requests carry an AbortSignal that fires when the client disconnects.
 */
export const serveNode = (
  handler: HttpHandler,
  options: ServeNodeOptions,
): Promise<NodeHttpServer> => {
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new TypeError("maxBodyBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new TypeError("port must be an integer in 0..65535");
  }
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(gracefulTimeoutMs) || gracefulTimeoutMs < 0) {
    throw new TypeError("gracefulTimeoutMs must be a non-negative safe integer");
  }
  const closeApplication = options.closeApplication === true;
  const host = options.host ?? "127.0.0.1";

  let closing = false;
  let closeInvocation: Promise<void> | null = null;

  const server = createServer((request, response) => {
    void handleRaw(handler, request, response, maxBodyBytes, () => closing);
  });

  const close = (): Promise<void> => {
    closeInvocation ??= (async () => {
      closing = true;
      await new Promise<void>((resolveClose, rejectClose) => {
        // close() resolves once every remaining connection has ended.
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        );
        server.closeIdleConnections();
        if (gracefulTimeoutMs === 0) {
          server.closeAllConnections();
          return;
        }
        const timer = setTimeout(() => server.closeAllConnections(), gracefulTimeoutMs);
        timer.unref();
        server.once("close", () => clearTimeout(timer));
      });
      if (closeApplication) {
        // Drain first, dispose after: app.close() runs only once no request
        // can still be mid-dispatch on this host.
        const app = handler.app as { readonly close?: () => Promise<void> } | undefined;
        if (app !== undefined && typeof app.close === "function") await app.close();
      }
    })();
    return closeInvocation;
  };

  return new Promise<NodeHttpServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(
        Object.freeze({
          server,
          url: `http://${urlHost(address)}:${address.port}`,
          close,
        }),
      );
    });
  });
};
