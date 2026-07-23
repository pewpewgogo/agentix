import type { Principal } from "@agentix/core";

import type { Awaitable } from "./route.js";

export type PrincipalExtractor = (
  request: Request,
) => Awaitable<Principal | null>;

export class AuthenticationError extends Error {
  public readonly code: string;

  public constructor(message = "Authentication failed.", code = "UNAUTHENTICATED") {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export interface BearerPrincipalExtractorOptions {
  readonly resolve: (token: string, request: Request) => Awaitable<Principal | null>;
}

/** Extracts a bearer token and delegates trust decisions to an explicit resolver. */
export const createBearerPrincipalExtractor = (
  options: BearerPrincipalExtractorOptions,
): PrincipalExtractor =>
  async (request) => {
    const authorization = request.headers.get("authorization");
    if (authorization === null) {
      return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match?.[1] === undefined || match[1].trim().length === 0) {
      throw new AuthenticationError("The Authorization header is malformed.");
    }
    return options.resolve(match[1].trim(), request);
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
    const id = request.headers.get(idHeader)?.trim();
    if (id === undefined || id.length === 0) {
      return null;
    }
    const rawPermissions = request.headers.get(permissionsHeader) ?? "";
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
