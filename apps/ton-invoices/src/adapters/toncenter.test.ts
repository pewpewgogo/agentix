/**
 * Unit tests for the toncenter v3 chain watcher over stubbed fetch
 * fixtures: URL/header construction, incoming-transfer mapping, semantic
 * skips vs STRICT failures on malformed bodies, and abort-signal
 * passthrough. No network involved.
 */
import { describe, expect, it } from "vitest";

import { createToncenterPull, parseIncomingTransfer } from "./toncenter.js";

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const stubFetch = (status: number, body: unknown) => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
};

/** One realistic v3 transaction with an incoming text-comment transfer. */
const incomingTx = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hash: "hash-1",
  lt: "12345",
  in_msg: {
    source: "0:abcdef",
    value: "1500000000",
    message_content: { decoded: { type: "text_comment", comment: "inv-1" } },
  },
  ...over,
});

describe("toncenter pull", () => {
  it("requests /transactions with account, start_lt = sinceLt + 1, sort=asc", async () => {
    const stub = stubFetch(200, { transactions: [incomingTx()] });
    const pull = createToncenterPull({
      address: "UQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2",
      fetchImpl: stub.fetchImpl,
    });

    const { transfers } = await pull({ sinceLt: "100" });

    expect(stub.requests[0]?.url).toBe(
      "https://toncenter.com/api/v3/transactions" +
        "?account=UQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2" +
        "&start_lt=101&limit=100&sort=asc",
    );
    expect(transfers).toEqual([
      { txHash: "hash-1", lt: "12345", amountNano: "1500000000", comment: "inv-1" },
    ]);
  });

  it("sends the API key header only when configured", async () => {
    const withKey = stubFetch(200, { transactions: [] });
    await createToncenterPull({
      address: "addr",
      apiKey: "secret-key",
      fetchImpl: withKey.fetchImpl,
    })({ sinceLt: "0" });
    expect(
      (withKey.requests[0]?.init?.headers as Record<string, string>)["X-API-Key"],
    ).toBe("secret-key");

    const withoutKey = stubFetch(200, { transactions: [] });
    await createToncenterPull({ address: "addr", fetchImpl: withoutKey.fetchImpl })({
      sinceLt: "0",
    });
    expect(
      (withoutKey.requests[0]?.init?.headers as Record<string, string>)["X-API-Key"],
    ).toBeUndefined();
  });

  it("skips non-transfer transactions but keeps strict order by lt", async () => {
    const stub = stubFetch(200, {
      transactions: [
        incomingTx({ hash: "later", lt: "300" }),
        incomingTx({ hash: "external", lt: "200", in_msg: { source: null, value: "5" } }),
        incomingTx({ hash: "no-in-msg", lt: "150", in_msg: null }),
        incomingTx({
          hash: "zero-value",
          lt: "140",
          in_msg: { source: "0:a", value: "0" },
        }),
        incomingTx({ hash: "earlier", lt: "120" }),
      ],
    });
    const pull = createToncenterPull({ address: "addr", fetchImpl: stub.fetchImpl });

    const { transfers } = await pull({ sinceLt: "0" });
    expect(transfers.map((t) => [t.txHash, t.lt])).toEqual([
      ["earlier", "120"],
      ["later", "300"],
    ]);
  });

  it("drops transfers at or below the cursor even if the API returns them", async () => {
    const stub = stubFetch(200, {
      transactions: [incomingTx({ hash: "old", lt: "100" }), incomingTx({ hash: "new", lt: "101" })],
    });
    const pull = createToncenterPull({ address: "addr", fetchImpl: stub.fetchImpl });
    const { transfers } = await pull({ sinceLt: "100" });
    expect(transfers.map((t) => t.txHash)).toEqual(["new"]);
  });

  it("throws on a non-2xx answer with the status in the message", async () => {
    const stub = stubFetch(429, { error: "rate limit exceeded" });
    const pull = createToncenterPull({ address: "addr", fetchImpl: stub.fetchImpl });
    await expect(pull({ sinceLt: "0" })).rejects.toThrow(/toncenter answered 429/);
  });

  it("is STRICT about malformed BODIES (page-level) instead of mis-parsing payments", async () => {
    const cases: Array<[string, unknown]> = [
      ["transactions missing", {}],
      ["transactions not an array", { transactions: "nope" }],
    ];
    for (const [, body] of cases) {
      const stub = stubFetch(200, body);
      const pull = createToncenterPull({ address: "addr", fetchImpl: stub.fetchImpl });
      await expect(pull({ sinceLt: "0" })).rejects.toThrow(/toncenter response malformed/);
    }

    const notJson = stubFetch(200, "not json at all");
    await expect(
      createToncenterPull({ address: "addr", fetchImpl: notJson.fetchImpl })({
        sinceLt: "0",
      }),
    ).rejects.toThrow(/not JSON/);
  });

  it("QUARANTINES an unparseable transaction and keeps the healthy transfers of the page", async () => {
    // Failing the whole page would pin the cursor: the same page re-fetches
    // and re-fails every poll, and no payment is ever credited again.
    const stub = stubFetch(200, {
      transactions: [
        incomingTx({ hash: "good", lt: "10" }),
        { hash: "bad", lt: "11", in_msg: { source: "0:b", value: 1.5e21 } },
      ],
    });
    const pull = createToncenterPull({ address: "addr", fetchImpl: stub.fetchImpl });

    const { transfers, malformed } = await pull({ sinceLt: "0" });
    expect(transfers.map((t) => t.txHash)).toEqual(["good"]);
    expect(malformed).toEqual([
      {
        path: "$.transactions[1]",
        detail: expect.stringContaining("$.transactions[1].in_msg.value"),
        txHash: "bad",
      },
    ]);
  });

  it("quarantines per-transaction field failures (hash/lt/value/in_msg) with the parser path", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["hash missing", incomingTx({ hash: undefined }), "$.transactions[0].hash"],
      ["lt not decimal", incomingTx({ lt: "abc" }), "$.transactions[0].lt"],
      [
        "value not decimal",
        incomingTx({ in_msg: { source: "0:a", value: "1.5" } }),
        "$.transactions[0].in_msg.value",
      ],
      ["in_msg not an object", incomingTx({ in_msg: 42 }), "$.transactions[0].in_msg"],
      [
        "value beyond numeric(30,0)",
        incomingTx({ in_msg: { source: "0:a", value: "1".repeat(31) } }),
        "$.transactions[0].in_msg.value",
      ],
      [
        "oversized hash",
        incomingTx({ hash: "h".repeat(129) }),
        "$.transactions[0].hash",
      ],
      ["mistyped now", incomingTx({ now: "abc" }), "$.transactions[0].now"],
    ];
    for (const [label, tx, path] of cases) {
      const stub = stubFetch(200, { transactions: [tx] });
      const pull = createToncenterPull({ address: "addr", fetchImpl: stub.fetchImpl });
      const { transfers, malformed } = await pull({ sinceLt: "0" });
      expect([label, transfers.length]).toEqual([label, 0]);
      expect([label, malformed[0]?.detail]).toEqual([
        label,
        expect.stringContaining(path),
      ]);
    }
  });

  it("normalizes leading-zero lt/value to the domain grammar instead of faulting the effect re-parse", async () => {
    // '007' / '0100' previously passed the adapter but failed the port's
    // LogicalTime/AmountNano re-parse — an INVALID_EFFECT_OUTPUT poison pill.
    const stub = stubFetch(200, {
      transactions: [incomingTx({ lt: "007", in_msg: { source: "0:a", value: "0100" } })],
    });
    const pull = createToncenterPull({ address: "addr", fetchImpl: stub.fetchImpl });
    const { transfers, malformed } = await pull({ sinceLt: "0" });
    expect(malformed).toEqual([]);
    expect(transfers).toEqual([{ txHash: "hash-1", lt: "7", amountNano: "100" }]);
  });

  it("forwards the effect abort signal to fetch (the port's timeout budget)", async () => {
    const stub = stubFetch(200, { transactions: [] });
    const pull = createToncenterPull({ address: "addr", fetchImpl: stub.fetchImpl });
    const controller = new AbortController();

    await pull({ sinceLt: "0" }, { signal: controller.signal });
    expect(stub.requests[0]?.init?.signal).toBe(controller.signal);
  });
});

describe("parseIncomingTransfer", () => {
  it("keeps a transfer without a decodable comment, minus the comment", () => {
    expect(
      parseIncomingTransfer(
        incomingTx({ in_msg: { source: "0:a", value: "77", message_content: null } }),
        "$.t",
      ),
    ).toEqual({ txHash: "hash-1", lt: "12345", amountNano: "77" });
  });

  it("accepts numeric lt/value fields (normalized to strings)", () => {
    expect(
      parseIncomingTransfer(
        incomingTx({ lt: 42, in_msg: { source: "0:a", value: 1000 } }),
        "$.t",
      ),
    ).toEqual({ txHash: "hash-1", lt: "42", amountNano: "1000" });
  });

  it("normalizes the transaction's on-chain time (`now`, unix seconds) to UTC ISO as `utime`", () => {
    expect(parseIncomingTransfer(incomingTx({ now: 946_684_800 }), "$.t")).toEqual({
      txHash: "hash-1",
      lt: "12345",
      amountNano: "1500000000",
      comment: "inv-1",
      utime: "2000-01-01T00:00:00.000Z",
    });
    // Absent on-chain time stays absent (matching falls back to the poller).
    expect(parseIncomingTransfer(incomingTx(), "$.t")).not.toHaveProperty("utime");
  });

  it("truncates an oversized comment to the domain cap instead of rejecting the payment", () => {
    const transfer = parseIncomingTransfer(
      incomingTx({
        in_msg: {
          source: "0:a",
          value: "77",
          message_content: { decoded: { type: "text_comment", comment: "x".repeat(600) } },
        },
      }),
      "$.t",
    );
    expect(transfer?.comment).toBe("x".repeat(500));
  });

  it("ignores non-text decoded payloads", () => {
    expect(
      parseIncomingTransfer(
        incomingTx({
          in_msg: {
            source: "0:a",
            value: "77",
            message_content: { decoded: { type: "jetton_transfer", comment: "x" } },
          },
        }),
        "$.t",
      ),
    ).toEqual({ txHash: "hash-1", lt: "12345", amountNano: "77" });
  });
});
