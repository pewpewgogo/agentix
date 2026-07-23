import type { IncomingMessage, ServerResponse } from "node:http";

import { jsonResponse } from "./route.js";
import type { HttpHandler } from "./handler.js";

export interface NodeHttpListenerOptions {
  /** Used only when the Node request has no Host header. */
  readonly fallbackOrigin?: string;
  readonly trustForwardedProto?: boolean;
  /** Defaults to one mebibyte because this thin host buffers request bodies. */
  readonly maxBodyBytes?: number;
}

class RequestBodyTooLargeError extends Error {}

const requestUrl = (
  request: IncomingMessage,
  options: NodeHttpListenerOptions,
): URL => {
  const host = request.headers.host;
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedProtocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const protocol =
    options.trustForwardedProto === true && forwardedProtocol !== undefined
      ? forwardedProtocol.split(",")[0]?.trim()
      : "http";
  const origin =
    host === undefined
      ? options.fallbackOrigin ?? `${protocol ?? "http"}://localhost`
      : `${protocol ?? "http"}://${host}`;
  return new URL(request.url ?? "/", origin);
};

const webHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item));
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
};

const readBody = async (
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<ArrayBuffer | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bodyBytes += bytes.byteLength;
    if (bodyBytes > maxBodyBytes) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return Uint8Array.from(Buffer.concat(chunks)).buffer;
};

const writeResponse = async (
  response: Response,
  destination: ServerResponse,
): Promise<void> => {
  destination.statusCode = response.status;
  response.headers.forEach((value, name) => {
    destination.setHeader(name, value);
  });
  if (response.body === null) {
    destination.end();
    return;
  }
  destination.end(Buffer.from(await response.arrayBuffer()));
};

/** Adapts Web Request/Response values to a Node HTTP listener without listening. */
export const createNodeHttpListener = (
  handler: HttpHandler,
  options: NodeHttpListenerOptions = {},
): ((request: IncomingMessage, response: ServerResponse) => void) => {
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new TypeError("maxBodyBytes must be a non-negative safe integer.");
  }

  return (request, response) => {
    void (async () => {
      try {
        const body = await readBody(request, maxBodyBytes);
        const webRequest = new Request(requestUrl(request, options), {
          method: request.method ?? "GET",
          headers: webHeaders(request),
          ...(body === undefined ? {} : { body }),
        });
        await writeResponse(await handler(webRequest), response);
      } catch (error: unknown) {
        if (!response.headersSent) {
          await writeResponse(
            error instanceof RequestBodyTooLargeError
              ? jsonResponse(
                  {
                    ok: false,
                    error: {
                      code: "REQUEST_BODY_TOO_LARGE",
                      message: "The request body is too large.",
                    },
                  },
                  413,
                )
              : jsonResponse(
                  {
                    ok: false,
                    error: {
                      code: "INTERNAL_ERROR",
                      message: "The Node HTTP host failed unexpectedly.",
                    },
                  },
                  500,
                ),
            response,
          );
        } else {
          response.destroy();
        }
      }
    })();
  };
};
