import type { DispatchObserver } from "@agentix/core";

/** Milliseconds with microsecond precision from a bigint nanosecond reading. */
const millis = (durationNs: bigint): number =>
  Number(durationNs / 1000n) / 1000;

const requestIdOf = (meta: unknown): string | undefined => {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)["requestId"];
  return typeof value === "string" ? value : undefined;
};

export type LogLine = (line: string) => void;

/**
 * Structured JSON logs from the dispatch lifecycle. The HTTP adapter passes
 * `meta: { requestId }` on every dispatch, so each log line correlates with
 * the `x-request-id` response header of the request that caused it.
 *
 * The same five callbacks are the OpenTelemetry seam — no framework changes
 * needed, only a different observer (and the OTel SDK as a dependency):
 *
 *   import { trace, SpanStatusCode } from "@opentelemetry/api";
 *   const tracer = trace.getTracer("pg-notes");
 *   const observer: DispatchObserver = {
 *     dispatchStarted: ({ operationId, meta }) =>
 *       tracer.startSpan(operationId, {
 *         attributes: { "request.id": String(requestIdOf(meta)) },
 *       }),
 *     effectSettled: ({ effectId, ok, durationNs, token }) =>
 *       (token as Span).addEvent(effectId, { ok, ms: millis(durationNs) }),
 *     dispatchSettled: ({ kind, code, token }) => {
 *       const span = token as Span;
 *       if (kind !== "completed" || code !== undefined) {
 *         span.setStatus({ code: SpanStatusCode.ERROR, message: code });
 *       }
 *       span.end();
 *     },
 *   };
 *
 * dispatchStarted's return value arrives as `token` in every later callback
 * of the same dispatch, which is exactly a span's lifetime.
 */
export const createConsoleObserver = (
  log: LogLine = (line) => {
    console.log(line);
  },
): DispatchObserver => ({
  dispatchSettled({ operationId, kind, code, durationNs, meta }) {
    log(
      JSON.stringify({
        at: new Date().toISOString(),
        msg: "dispatch.settled",
        operationId,
        kind,
        ...(code === undefined ? {} : { code }),
        durationMs: millis(durationNs),
        ...(requestIdOf(meta) === undefined
          ? {}
          : { requestId: requestIdOf(meta) }),
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
