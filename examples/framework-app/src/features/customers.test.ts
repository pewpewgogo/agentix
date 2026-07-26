import { createApplication } from "@agentix/core";
import { testCommand } from "@agentix/testing";
import { describe, expect, it } from "vitest";

import {
  CustomerClock,
  CustomerStorage,
  customers,
  type Customer,
} from "./customers.js";

describe("customers.create", () => {
  it("normalizes and persists through only its declared capabilities", async () => {
    const stored = new Map<string, Customer>();
    const claims = new Set<string>();
    const application = createApplication({
      features: [customers],
      adapters: [
        CustomerStorage.adapter({
          claim: (id) => {
            if (stored.has(id) || claims.has(id)) return false;
            claims.add(id);
            return true;
          },
          releaseClaim: (id) => {
            claims.delete(id);
            return true;
          },
          get: (id) => stored.get(id),
          save: (customer) => {
            stored.set(customer.id, customer);
            claims.delete(customer.id);
            return customer;
          },
        }),
        CustomerClock.adapter({ now: () => "2040-01-01T00:00:00.000Z" }),
      ],
      mode: "test",
    });

    const result = await testCommand({
      application,
      operation: customers.operations.create,
      input: { id: " customer-1 ", name: " Ada Lovelace " },
    });

    expect(result).toMatchObject({
      kind: "completed",
      outcome: {
        ok: true,
        value: {
          id: "customer-1",
          name: "Ada Lovelace",
          status: "active",
        },
      },
    });
    expect(stored.get("customer-1")).toMatchObject({
      name: "Ada Lovelace",
      status: "active",
    });
    expect(result.trace?.map((entry) =>
      entry.type === "effect" ? entry.effectId : entry.eventId,
    )).toEqual([
      "customerStorage.claim",
      "customerClock.now",
      "customerStorage.save",
    ]);
  });

  it("rejects duplicates before reading the clock", async () => {
    const stored = new Map<string, Customer>();
    let nowCalls = 0;
    const application = createApplication({
      features: [customers],
      adapters: [
        CustomerStorage.adapter({
          claim: (id) => !stored.has(id),
          releaseClaim: () => true,
          get: (id) => stored.get(id),
          save: (customer) => {
            stored.set(customer.id, customer);
            return customer;
          },
        }),
        CustomerClock.adapter({
          now: () => {
            nowCalls += 1;
            return "2040-01-01T00:00:00.000Z";
          },
        }),
      ],
      mode: "test",
    });

    const first = await testCommand({
      application,
      operation: customers.operations.create,
      input: { id: "customer-1", name: "Ada" },
    });
    expect(first).toMatchObject({ kind: "completed", outcome: { ok: true } });

    const duplicate = await testCommand({
      application,
      operation: customers.operations.create,
      input: { id: "customer-1", name: "Ada" },
    });
    expect(duplicate).toMatchObject({
      kind: "completed",
      outcome: {
        ok: false,
        error: {
          code: "CUSTOMER_ALREADY_EXISTS",
          details: { id: "customer-1" },
        },
      },
    });
    expect(nowCalls).toBe(1);
  });
});
