import type { Principal } from "@agentixdev/core";

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
  /**
   * Single-cookie lookup over the `Cookie` request header. The header is
   * parsed lazily, once per request, on first access. Returns undefined when
   * the header is absent or the cookie is not present; malformed pairs (no
   * `=`, empty name) are skipped; the first occurrence of a name wins.
   */
  readonly cookie: (name: string) => string | undefined;
}

/* ------------------------------------------------------------------ */
/* Cookie parsing (lazy, once per request)                            */
/* ------------------------------------------------------------------ */

const EMPTY_COOKIES: ReadonlyMap<string, string> = new Map();

const decodeCookieValue = (raw: string): string => {
  let value = raw;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // malformed percent-encoding: keep the raw value
  }
};

const parseCookieHeader = (header: string): ReadonlyMap<string, string> => {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue; // malformed pair: no "="
    const name = part.slice(0, separator).trim();
    if (name.length === 0) continue; // malformed pair: empty name
    if (cookies.has(name)) continue; // first occurrence wins
    cookies.set(name, decodeCookieValue(part.slice(separator + 1).trim()));
  }
  return cookies;
};

/**
 * Builds the lazy `cookie(name)` accessor of HttpRequestView from a header
 * lookup. The `Cookie` header is read and parsed at most once, on the first
 * `cookie()` call; requests that never touch cookies never parse anything.
 */
export const createCookieLookup = (
  headers: (name: string) => string | undefined,
): ((name: string) => string | undefined) => {
  let parsed: ReadonlyMap<string, string> | null = null;
  return (name) => {
    if (parsed === null) {
      const header = headers("cookie");
      parsed = header === undefined ? EMPTY_COOKIES : parseCookieHeader(header);
    }
    return parsed.get(name);
  };
};

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
