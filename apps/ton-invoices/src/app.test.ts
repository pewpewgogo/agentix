/**
 * Assembly tests: the reconcile poller's operator signals. A failing pull
 * (toncenter down, or a page the watcher rejects wholesale) must produce
 * `reconcile.failed` lines that carry the UNDERLYING effect cause — the
 * parser's `$.transactions[i]` path, not just "Dispatch fault:
 * EFFECT_FAILURE" — and consecutive failures must escalate to a
 * `reconcile.stalled` alert, because a pinned cursor means no payment is
 * being credited. Quarantined (malformed) transactions are logged with their
 * path every tick so the poison transaction is identifiable.
 */
import { createTestApplication } from "@agentixdev/testing";
import { describe, expect, it } from "vitest";

import { createMemoryInvoiceStore } from "./adapters/memory.js";
import { createReconcilePoller } from "./app.js";
import { invoices, type IncomingTransfer } from "./features/invoices.js";

const ADDRESS = "UQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2";

interface PullPage {
  readonly transfers?: IncomingTransfer[];
  readonly malformed?: Array<{ path: string; detail: string; txHash?: string }>;
  readonly throwWith?: string;
}

const build = (pages: PullPage[]) => {
  const store = createMemoryInvoiceStore();
  const remaining = [...pages];
  const harness = createTestApplication({
    features: [invoices],
    adapters: [store.adapter],
    overrides: {
      "invoiceConfig.get": () => ({
        receiveAddress: ADDRESS,
        ttlMs: 300_000,
        expiryGraceMs: 0,
      }),
      "invoiceClock.plusMs": ({ iso, ms }: { iso: string; ms: number }) =>
        new Date(Date.parse(iso) + ms).toISOString(),
      "chainWatcher.pull": () => {
        const page = remaining.shift() ?? { transfers: [] };
        if (page.throwWith !== undefined) throw new Error(page.throwWith);
        return {
          transfers: page.transfers ?? [],
          malformed: page.malformed ?? [],
        };
      },
    },
  });

  const logs: string[] = [];
  const errors: string[] = [];
  const poller = createReconcilePoller(harness.app, {
    pollMs: 1_000_000, // never fires in tests; tick() drives it
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
    alertAfterFailures: 3,
  });
  const parsedErrors = () => errors.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { harness, store, poller, logs, errors, parsedErrors };
};

const PARSER_FAILURE =
  "toncenter response malformed at $.transactions[1].in_msg.value: expected a non-negative decimal integer";

describe("createReconcilePoller", () => {
  it("logs each failed tick with the underlying effect cause and escalates to reconcile.stalled after 3", async () => {
    const { poller, parsedErrors } = build([
      { throwWith: PARSER_FAILURE },
      { throwWith: PARSER_FAILURE },
      { throwWith: PARSER_FAILURE },
    ]);

    await poller.tick();
    await poller.tick();
    await poller.tick();

    const entries = parsedErrors();
    const failed = entries.filter((entry) => entry["msg"] === "reconcile.failed");
    expect(failed).toHaveLength(3);
    expect(failed.map((entry) => entry["consecutiveFailures"])).toEqual([1, 2, 3]);
    // The operator can identify the poison transaction from the log alone.
    for (const entry of failed) {
      expect(entry["cause"]).toContain("$.transactions[1]");
      expect(entry["code"]).toBe("EFFECT_FAILURE");
    }
    const stalled = entries.filter((entry) => entry["msg"] === "reconcile.stalled");
    expect(stalled).toHaveLength(1);
  });

  it("resets the failure streak on a successful tick", async () => {
    const { poller, parsedErrors } = build([
      { throwWith: "toncenter answered 500" },
      { throwWith: "toncenter answered 500" },
      {}, // recovery
      { throwWith: "toncenter answered 500" },
    ]);

    await poller.tick();
    await poller.tick();
    await poller.tick();
    await poller.tick();

    const entries = parsedErrors();
    const failed = entries.filter((entry) => entry["msg"] === "reconcile.failed");
    expect(failed.map((entry) => entry["consecutiveFailures"])).toEqual([1, 2, 1]);
    expect(entries.filter((entry) => entry["msg"] === "reconcile.stalled")).toHaveLength(0);
  });

  it("logs quarantined (malformed) transactions with their parser path every tick", async () => {
    const { poller, parsedErrors } = build([
      {
        malformed: [
          { path: "$.transactions[4]", detail: "expected a unix-seconds integer", txHash: "bad" },
        ],
      },
    ]);

    await poller.tick();

    const entries = parsedErrors();
    const malformed = entries.filter(
      (entry) => entry["msg"] === "reconcile.malformed_transactions",
    );
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({
      count: 1,
      entries: [{ path: "$.transactions[4]", txHash: "bad" }],
    });
  });

  it("logs a reconcile.completed summary including the unattributed count", async () => {
    const { harness, poller, logs } = build([
      { transfers: [{ txHash: "tx-1", lt: "10", amountNano: "5" }] },
    ]);
    void harness;

    await poller.tick();

    const completed = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry["msg"] === "reconcile.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      paid: 0,
      unattributed: 1, // the no_match transfer was recorded, not dropped
      transfersSeen: 1,
      cursor: "10",
    });
  });
});
