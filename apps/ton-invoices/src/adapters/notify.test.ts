/**
 * Unit tests for the notifier adapters over stubbed fetch. Delivery
 * failures must THROW (visible EFFECT_FAILURE via the subscriber), never
 * report success.
 */
import { describe, expect, it } from "vitest";

import type { InvoicePaidPayload } from "../features/invoices.js";
import { createTelegramNotifier, createWebhookNotifier } from "./notify.js";

const notification: InvoicePaidPayload = {
  invoiceId: "inv-1",
  amountNano: "1000",
  transferAmountNano: "1500",
  txHash: "tx-1",
  comment: "tag-1",
  paidAt: "2026-01-01T00:00:00.000Z",
};

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const stubFetch = (status: number, body: unknown = {}) => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, requests };
};

const send = async (
  adapter: { operations: Readonly<Record<string, (input: never) => unknown>> },
  signal?: AbortSignal,
): Promise<unknown> =>
  (
    adapter.operations["send"] as unknown as (
      input: InvoicePaidPayload,
      options: { signal?: AbortSignal },
    ) => Promise<unknown>
  )(notification, { signal: signal ?? new AbortController().signal });

describe("webhook notifier", () => {
  it("POSTs the invoice.paid payload as JSON and reports delivery", async () => {
    const stub = stubFetch(200);
    const adapter = createWebhookNotifier({
      url: "https://hooks.example/ton",
      fetchImpl: stub.fetchImpl,
    });

    await expect(send(adapter)).resolves.toEqual({ delivered: true });

    const request = stub.requests[0];
    expect(request?.url).toBe("https://hooks.example/ton");
    expect(request?.init?.method).toBe("POST");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      type: "invoice.paid",
      ...notification,
    });
  });

  it("throws on a non-2xx answer", async () => {
    const stub = stubFetch(503);
    const adapter = createWebhookNotifier({
      url: "https://hooks.example/ton",
      fetchImpl: stub.fetchImpl,
    });
    await expect(send(adapter)).rejects.toThrow(/webhook answered 503/);
  });

  it("hands the effect signal to fetch so the port timeout can cancel it", async () => {
    const stub = stubFetch(200);
    const adapter = createWebhookNotifier({
      url: "https://hooks.example/ton",
      fetchImpl: stub.fetchImpl,
    });
    const controller = new AbortController();
    await send(adapter, controller.signal);
    expect(stub.requests[0]?.init?.signal).toBe(controller.signal);
  });
});

describe("telegram notifier", () => {
  it("calls sendMessage with the chat id and a human-readable text", async () => {
    const stub = stubFetch(200, { ok: true });
    const adapter = createTelegramNotifier({
      botToken: "123:abc",
      chatId: "-10042",
      fetchImpl: stub.fetchImpl,
    });

    await expect(send(adapter)).resolves.toEqual({ delivered: true });

    const request = stub.requests[0];
    expect(request?.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(String(request?.init?.body)) as {
      chat_id: string;
      text: string;
    };
    expect(body.chat_id).toBe("-10042");
    expect(body.text).toContain("inv-1");
    expect(body.text).toContain("1500");
    expect(body.text).toContain("tx-1");
  });

  it("throws when Telegram answers ok:false even with HTTP 200", async () => {
    const stub = stubFetch(200, { ok: false, description: "chat not found" });
    const adapter = createTelegramNotifier({
      botToken: "123:abc",
      chatId: "-10042",
      fetchImpl: stub.fetchImpl,
    });
    await expect(send(adapter)).rejects.toThrow(/ok: false/);
  });
});
