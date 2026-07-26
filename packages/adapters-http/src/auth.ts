import type { Principal } from "@agentix/core";

import type { Awaitable } from "./router.js";

/**
 * Minimal host-agnostic request view. Both entries provide it: the Web entry
 * wraps `Request`, the raw Node host wraps `IncomingMessage` — neither path
 * constructs an undici Request for authentication.
 */
export interface HttpRequestView {
  readonly method: string;
  /** Percent-encoded pathname (no query string). */
  readonly path: string;
  /** Case-insensitive single-value header lookup. */
  readonly headers: (name: string) => string | undefined;
}

/**
 * Returning `null` yields an ANONYMOUS request (core authorize() then rejects
 * operations that require permissions). Throw AuthenticationError to answer
 * 401 for malformed credentials.
 */
export type PrincipalExtractor = (
  request: HttpRequestView,
) => Awaitable<Principal | null>;

export class AuthenticationError extends Error {
  readonly code: string;

  constructor(message = "Authentication failed.", code = "UNAUTHENTICATED") {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export interface BearerPrincipalExtractorOptions {
  readonly resolve: (
    token: string,
    request: HttpRequestView,
  ) => Awaitable<Principal | null>;
}

/** Extracts a bearer token and delegates trust decisions to an explicit resolver. */
export const createBearerPrincipalExtractor =
  (options: BearerPrincipalExtractorOptions): PrincipalExtractor =>
  async (request) => {
    const authorization = request.headers("authorization");
    if (authorization === undefined) return null;
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const token = match?.[1]?.trim();
    if (token === undefined || token.length === 0) {
      throw new AuthenticationError("The Authorization header is malformed.");
    }
    return options.resolve(token, request);
  };

export interface TrustedHeaderPrincipalOptions {
  readonly idHeader?: string;
  readonly permissionsHeader?: string;
  readonly separator?: string;
}

/**
 * Reads identity injected by a trusted proxy. Do not expose these headers
 * directly to untrusted clients without stripping and replacing them upstream.
 */
export const createTrustedHeaderPrincipalExtractor = (
  options: TrustedHeaderPrincipalOptions = {},
): PrincipalExtractor => {
  const idHeader = options.idHeader ?? "x-principal-id";
  const permissionsHeader = options.permissionsHeader ?? "x-principal-permissions";
  const separator = options.separator ?? ",";

  return (request) => {
    const id = request.headers(idHeader)?.trim();
    if (id === undefined || id.length === 0) return null;
    const rawPermissions = request.headers(permissionsHeader) ?? "";
    const permissions = [
      ...new Set(
        rawPermissions
          .split(separator)
          .map((permission) => permission.trim())
          .filter((permission) => permission.length > 0),
      ),
    ];
    return { id, permissions };
  };
};
