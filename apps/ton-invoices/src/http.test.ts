/**
 * HTTP surface tests without sockets: envelope, statuses, bearer
 * authentication (401 vs 403), the public invoice lookup, param routes,
 * query-string filters, the health path, and the CORS-off default — all
 * through `testHttp` driving the handler's Web entry, with persistence and
 * chain replaced by memory adapters.
 */
import { principal } from "@agentixdev/core";
import { createTestApplication, testHttp } from "@agentixdev/testing";
import { describe, expect, it } from "vitest";

import {
  createMemoryChainWatcher,
  createMemoryInvoiceStore,
} from "./adapters/memory.js";
import { createTonInvoicesHandler } from "./app.js";
import { invoices, type Invoice } from "./features/invoices.js";

const ADDRESS = "UQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2";
const TTL_MS = 300_000;

const TOKENS = {
  "admin-token": principal("admin", [
    "invoices:create",
    "invoices:read",
    "invoices:cancel",
    "invoices:reconcile",
  ]),
  "reader-token": principal("reader", ["invoices:read"]),
};

const build = () => {
  const store = createMemoryInvoiceStore();
  const watcher = createMemoryChainWatcher();
  const harness = createTestApplication({
    features: [invoices],
    adapters: [store.adapter, watcher.adapter],
    overrides: {
      "invoiceConfig.get": () => ({
        receiveAddress: ADDRESS,
        ttlMs: TTL_MS,
        expiryGraceMs: 0,
      }),
      "invoiceClock.plusMs": ({ iso, ms }: { iso: string; ms: number }) =>
        new Date(Date.parse(iso) + ms).toISOString(),
    },
  });
  const handler = createTonInvoicesHandler(harness.app, {
    tokens: TOKENS,
    logError: () => {},
  });
  return { http: testHttp(handler), harness, store, watcher };
};

const createOne = async (http: ReturnType<typeof build>["http"]): Promise<Invoice> => {
  const created = await http.post(
    "/invoices",
    { amountNano: "1500000000", memo: "coffee" },
    { token: "admin-token" },
  );
  expect(created.status).toBe(201);
  return (created.body as { value: Invoice }).value;
};

describe("ton-invoices over HTTP", () => {
  it("creates through the envelope: 201, ton:// link, x-request-id", async () => {
    const { http } = build();
    const created = await http.post(
      "/invoices",
      { amountNano: "1500000000", memo: "coffee" },
      { token: "admin-token" },
    );

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      ok: true,
      value: {
        id: "id-1",
        amountNano: "1500000000",
        memo: "coffee",
        comment: "id-2",
        status: "pending",
        createdAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:05:00.000Z",
        paymentLink: `ton://transfer/${ADDRESS}?amount=1500000000&text=id-2`,
      },
    });
    expect(created.headers.get("x-request-id")).toMatch(/[\w-]+/);
  });

  it("answers 400 INVALID_INPUT for a float amount", async () => {
    const { http } = build();
    const bad = await http.post(
      "/invoices",
      { amountNano: "1.5" },
      { token: "admin-token" },
    );
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });

  it("serves the invoice publicly on the param route, 404 for unknown ids", async () => {
    const { http } = build();
    const invoice = await createOne(http);

    const found = await http.get(`/invoices/${invoice.id}`); // no token at all
    expect(found.status).toBe(200);
    expect((found.body as { value: Invoice }).value.id).toBe(invoice.id);

    const missing = await http.get("/invoices/ghost");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      ok: false,
      error: { code: "INVOICE_NOT_FOUND", details: { id: "ghost" } },
    });
  });

  it("guards list: anonymous 403, reader 200, ?status= filter, bogus filter 400", async () => {
    const { http } = build();
    await createOne(http);

    const anonymous = await http.get("/invoices");
    expect(anonymous.status).toBe(403);
    expect(anonymous.body).toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });

    const listed = await http.get("/invoices?status=pending", { token: "reader-token" });
    expect(listed.status).toBe(200);
    expect((listed.body as { value: Invoice[] }).value).toHaveLength(1);

    const empty = await http.get("/invoices?status=paid", { token: "reader-token" });
    expect((empty.body as { value: Invoice[] }).value).toHaveLength(0);

    const bogus = await http.get("/invoices?status=bogus", { token: "reader-token" });
    expect(bogus.status).toBe(400);
  });

  it("answers 401 UNKNOWN_TOKEN for a token outside the table", async () => {
    const { http } = build();
    const response = await http.get("/invoices", { token: "stolen-token" });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: { code: "UNKNOWN_TOKEN" } });
  });

  it("answers 401 for Object.prototype member names used as bearer tokens", async () => {
    // A plain-object token table would resolve these to truthy non-Principal
    // values ("toString" -> Function, "__proto__" -> Object.prototype) and
    // skip the UNKNOWN_TOKEN path; the digest Map must treat them exactly
    // like any other unknown token.
    const { http } = build();
    for (const token of [
      "toString",
      "constructor",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
    ]) {
      const response = await http.get("/invoices", { token });
      expect([token, response.status]).toEqual([token, 401]);
      expect(response.body).toEqual({ ok: false, error: { code: "UNKNOWN_TOKEN" } });
    }
  });

  it("cancels over the param route and 409s the second attempt", async () => {
    const { http } = build();
    const invoice = await createOne(http);

    const reader = await http.post(`/invoices/${invoice.id}/cancel`, undefined, {
      token: "reader-token",
    });
    expect(reader.status).toBe(403); // reader lacks invoices:cancel

    const cancelled = await http.post(`/invoices/${invoice.id}/cancel`, undefined, {
      token: "admin-token",
    });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { value: Invoice }).value.status).toBe("cancelled");

    const conflict = await http.post(`/invoices/${invoice.id}/cancel`, undefined, {
      token: "admin-token",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      ok: false,
      error: {
        code: "INVOICE_NOT_PENDING",
        details: { id: invoice.id, status: "cancelled" },
      },
    });
  });

  it("reconciles over HTTP and the paid invoice shows up on the public route", async () => {
    const { http, watcher } = build();
    const invoice = await createOne(http);
    watcher.push({
      txHash: "tx-1",
      lt: "101",
      amountNano: invoice.amountNano,
      comment: invoice.comment,
    });

    const forbidden = await http.post("/invoices/reconcile", undefined, {
      token: "reader-token",
    });
    expect(forbidden.status).toBe(403);

    const report = await http.post("/invoices/reconcile", undefined, {
      token: "admin-token",
    });
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      ok: true,
      value: { paid: [{ invoiceId: invoice.id, txHash: "tx-1" }], cursor: "101" },
    });

    const paid = await http.get(`/invoices/${invoice.id}`);
    expect((paid.body as { value: Invoice }).value.status).toBe("paid");
    expect((paid.body as { value: Invoice }).value.paidTxHash).toBe("tx-1");
  });

  it("serves unattributed transfers to readers on /invoices/transfers/unattributed", async () => {
    const { http, watcher } = build();
    const invoice = await createOne(http);
    watcher.push({
      txHash: "tx-under",
      lt: "9",
      amountNano: "1",
      comment: invoice.comment,
    });
    await http.post("/invoices/reconcile", undefined, { token: "admin-token" });

    const anonymous = await http.get("/invoices/transfers/unattributed");
    expect(anonymous.status).toBe(403);

    const listed = await http.get("/invoices/transfers/unattributed", {
      token: "reader-token",
    });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      ok: true,
      value: [{ txHash: "tx-under", amountNano: "1", reason: "underpaid" }],
    });
  });

  it("serves the liveness path without authentication", async () => {
    const { http } = build();
    const health = await http.get("/healthz");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
  });

  it("keeps CORS off by default: no allow-origin header, no preflight route", async () => {
    const { http } = build();
    const response = await http.request({
      method: "OPTIONS",
      path: "/invoices",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
      },
    });
    // Without a cors config the OPTIONS request is just an unroutable method.
    expect(response.status).toBe(405);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
