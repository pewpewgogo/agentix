/** Edge-safe surface: no Node built-ins anywhere in this module graph. */

export {
  AuthenticationError,
  createBearerPrincipalExtractor,
  createCookieLookup,
  createTrustedHeaderPrincipalExtractor,
} from "./auth.js";
export type {
  BearerPrincipalExtractorOptions,
  HttpRequestView,
  PrincipalExtractor,
  TrustedHeaderPrincipalOptions,
} from "./auth.js";

export { createHttpHandler, JSON_CONTENT_TYPE, RequestBodyLimitError } from "./handler.js";
export type {
  CorsOptions,
  CreateHttpHandlerOptions,
  HandlerRequest,
  HandlerResponse,
  HttpErrorInfo,
  HttpErrorObserver,
  HttpHandler,
  ResponseHeadersContext,
  ResponseHeadersHook,
} from "./handler.js";

export { defineHttpRoute } from "./route.js";
export type { DefineHttpRouteOptions } from "./route.js";

export { compileRouteTable, EMPTY_PARAMS, matchRoute, queryRecord } from "./router.js";
export type {
  Awaitable,
  BuildInput,
  CompiledRoute,
  CompiledRouteTable,
  HttpRequestContext,
  HttpRouteOverride,
  MatchResult,
  RouteBucket,
  RouteSegment,
} from "./router.js";

export type { HttpMethod } from "@agentixdev/core";
