/**
 * ChainWatcher adapter over the toncenter.com HTTP API v3.
 *
 * Endpoint used:
 *   GET {endpoint}/transactions?account=<address>&start_lt=<lt>&limit=<n>&sort=asc
 *   default endpoint: https://toncenter.com/api/v3
 *   API docs: https://toncenter.com/api/v3/ (OpenAPI UI)
 *
 * Authentication: optional API key sent as the `X-API-Key` header (issued by
 * @tonapibot on Telegram).
 *
 * Rate limits (as documented by toncenter): roughly 1 request/second without
 * a key and ~10 requests/second with a free key. The server's poller defaults
 * to POLL_MS=10000 — one request every 10 s — comfortably inside the
 * anonymous budget.
 *
 * Cursor semantics: `start_lt` is INCLUSIVE, so the adapter requests
 * `sinceLt + 1` and additionally drops anything at or below `sinceLt`
 * defensively. The transaction `lt` (logical time, strictly increasing per
 * account) is the cursor; the transaction `hash` identifies the transfer.
 *
 * Response validation is STRICT but ISOLATED per transaction: a malformed
 * BODY (not JSON, `transactions` missing/mistyped) throws, which the runtime
 * surfaces as an EFFECT_FAILURE fault — but ONE unparseable transaction is
 * QUARANTINED into the pull result's `malformed` list (path + detail + tx
 * hash when readable) instead of failing the page. Failing the whole page
 * would pin the cursor forever: every healthy payment behind the poison
 * transaction would stop being credited until someone hand-edited
 * `watcher_cursor`. Semantic skips (outbound-only txs, external messages,
 * zero value) are NOT errors.
 *
 * The accepted grammar is exactly the domain port's: decimal integers
 * (normalized of leading zeros) capped at 30 digits for lt/value, hash capped
 * at 128 chars, comment truncated to 500 — so a value the adapter accepts can
 * never fail the port's effect-output re-parse (which core runs in EVERY
 * runtime mode) and stall the poller that way.
 */
import type { BoundPortAdapter } from "@agentixdev/core";

import {
  ChainWatcher,
  type IncomingTransfer,
  type MalformedTransaction,
} from "../features/invoices.js";

export interface ToncenterChainWatcherOptions {
  /** The invoice receive address (friendly or raw form; sent verbatim). */
  readonly address: string;
  /** Optional toncenter API key (X-API-Key header). */
  readonly apiKey?: string;
  /** API base, default https://toncenter.com/api/v3 (no trailing slash). */
  readonly endpoint?: string;
  /** Page size per pull; toncenter v3 caps limit at 256. Default 100. */
  readonly limit?: number;
  /** Test seam; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = "https://toncenter.com/api/v3";
const DEFAULT_LIMIT = 100;

/* ------------------------------------------------------------------ */
/* Strict field readers                                               */
/* ------------------------------------------------------------------ */

/* Bounds mirror the domain schemas (AmountNano/LogicalTime max 30 digits,
 * txHash max 128, comment max 500) so the adapter's accepted grammar is never
 * looser than the port's. */
const MAX_DECIMAL_DIGITS = 30;
const MAX_HASH_CHARS = 128;
const MAX_COMMENT_CHARS = 500;
const MAX_DETAIL_CHARS = 500;

const malformed = (path: string, detail: string): Error =>
  new Error(`toncenter response malformed at ${path}: ${detail}`);

const asRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(path, "expected an object");
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, path: string, maxChars?: number): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(path, "expected a non-empty string");
  }
  if (maxChars !== undefined && value.length > maxChars) {
    throw malformed(path, `expected at most ${maxChars} characters`);
  }
  return value;
};

/** lt/value arrive as decimal strings (sometimes numbers); normalize strictly:
 * leading zeros are stripped ("007" -> "7", "000" -> "0") so the result always
 * satisfies the domain's LogicalTime/AmountNano grammar, and anything past 30
 * digits (numeric(30,0) in SQL) is malformed rather than silently accepted. */
const asDecimalString = (value: unknown, path: string): string => {
  const raw =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : value;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    throw malformed(path, "expected a non-negative decimal integer");
  }
  const text = raw.replace(/^0+(?=[0-9])/, "");
  if (text.length > MAX_DECIMAL_DIGITS) {
    throw malformed(path, `expected at most ${MAX_DECIMAL_DIGITS} digits`);
  }
  return text;
};

/* ------------------------------------------------------------------ */
/* Transaction parsing                                                */
/* ------------------------------------------------------------------ */

/** Parses one v3 transaction into an incoming transfer, or undefined when the
 * transaction is not an incoming value transfer (no in_msg, external message,
 * zero value). Malformed fields on the read path throw. */
export const parseIncomingTransfer = (
  value: unknown,
  path: string,
): IncomingTransfer | undefined => {
  const tx = asRecord(value, path);
  const txHash = asString(tx["hash"], `${path}.hash`, MAX_HASH_CHARS);
  const lt = asDecimalString(tx["lt"], `${path}.lt`);

  // On-chain transaction time (`now`, unix seconds) -> the same fixed-length
  // UTC ISO form the clock port produces; expiry matching prefers it over the
  // poller's wall clock. Tolerated as absent, but a mistyped value is
  // malformed — a wrong payment time could refuse or accept the wrong invoice.
  const rawUtime = tx["now"];
  let utime: string | undefined;
  if (rawUtime !== undefined && rawUtime !== null) {
    if (
      typeof rawUtime !== "number" ||
      !Number.isSafeInteger(rawUtime) ||
      rawUtime < 0
    ) {
      throw malformed(`${path}.now`, "expected a unix-seconds integer");
    }
    utime = new Date(rawUtime * 1000).toISOString();
  }

  const rawInMsg = tx["in_msg"];
  if (rawInMsg === undefined || rawInMsg === null) return undefined; // no inbound message
  const inMsg = asRecord(rawInMsg, `${path}.in_msg`);

  // Externally-originated messages (wallet init, etc.) carry no source; only
  // internal messages move value.
  const source = inMsg["source"];
  if (source === undefined || source === null || source === "") return undefined;
  asString(source, `${path}.in_msg.source`);

  const rawValue = inMsg["value"];
  if (rawValue === undefined || rawValue === null) return undefined;
  const amountNano = asDecimalString(rawValue, `${path}.in_msg.value`);
  if (amountNano === "0") return undefined; // not a value transfer

  let comment: string | undefined;
  const content = inMsg["message_content"];
  if (content !== undefined && content !== null) {
    const decoded = asRecord(content, `${path}.in_msg.message_content`)["decoded"];
    if (decoded !== undefined && decoded !== null) {
      const decodedRecord = asRecord(decoded, `${path}.in_msg.message_content.decoded`);
      const type = decodedRecord["type"];
      const rawComment = decodedRecord["comment"];
      if ((type === undefined || type === "text_comment") && typeof rawComment === "string") {
        // Truncated, not rejected: an oversized comment must not quarantine a
        // real payment, and invoice tags are far shorter than the cap.
        comment = rawComment.slice(0, MAX_COMMENT_CHARS);
      }
    }
  }

  return {
    txHash,
    lt,
    amountNano,
    ...(comment === undefined ? {} : { comment }),
    ...(utime === undefined ? {} : { utime }),
  };
};

/* ------------------------------------------------------------------ */
/* The pull handler + adapter                                         */
/* ------------------------------------------------------------------ */

/** Exported separately so unit tests drive it against stubbed fetch fixtures. */
export const createToncenterPull = (options: ToncenterChainWatcherOptions) => {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (
    input: { sinceLt: string },
    context?: { signal?: AbortSignal },
  ): Promise<{ transfers: IncomingTransfer[]; malformed: MalformedTransaction[] }> => {
    const startLt = (BigInt(input.sinceLt) + 1n).toString();
    const url =
      `${endpoint}/transactions?account=${encodeURIComponent(options.address)}` +
      `&start_lt=${startLt}&limit=${limit}&sort=asc`;

    // The ChainWatcher port declares timeoutMs; the runtime aborts `signal`
    // when the budget is exceeded, which cancels this fetch.
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        ...(options.apiKey === undefined ? {} : { "X-API-Key": options.apiKey }),
      },
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`toncenter answered ${response.status}: ${body}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw malformed("$", "body is not JSON");
    }
    const rawTransactions = asRecord(payload, "$")["transactions"];
    if (!Array.isArray(rawTransactions)) {
      throw malformed("$.transactions", "expected an array");
    }

    const since = BigInt(input.sinceLt);
    const transfers: IncomingTransfer[] = [];
    const malformedTransactions: MalformedTransaction[] = [];
    rawTransactions.forEach((tx, index) => {
      const path = `$.transactions[${index}]`;
      try {
        const transfer = parseIncomingTransfer(tx, path);
        if (transfer !== undefined && BigInt(transfer.lt) > since) {
          transfers.push(transfer);
        }
      } catch (cause: unknown) {
        // Quarantine, don't fail the page: the healthy transfers around a
        // poison transaction must keep settling, and the operator gets the
        // path + tx hash to investigate instead of a stalled cursor.
        const rawHash =
          typeof tx === "object" && tx !== null && !Array.isArray(tx)
            ? (tx as Record<string, unknown>)["hash"]
            : undefined;
        const detail =
          (cause instanceof Error ? cause.message : String(cause)).slice(
            0,
            MAX_DETAIL_CHARS,
          ) || "unparseable transaction";
        malformedTransactions.push({
          path,
          detail,
          ...(typeof rawHash === "string" && rawHash.length > 0
            ? { txHash: rawHash.slice(0, MAX_HASH_CHARS) }
            : {}),
        });
      }
    });
    transfers.sort((a, b) => (BigInt(a.lt) < BigInt(b.lt) ? -1 : 1));
    return { transfers, malformed: malformedTransactions };
  };
};

export const createToncenterChainWatcher = (
  options: ToncenterChainWatcherOptions,
): BoundPortAdapter => ChainWatcher.adapter({ pull: createToncenterPull(options) });
