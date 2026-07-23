import { bindPort, createApplication, ok } from "@agentix/core";
import { testCommand } from "@agentix/testing";
import { describe, expect, it } from "vitest";

import {
  CustomerClock,
  CustomerId,
  CustomerStorage,
  type Customer,
} from "./contract.js";
import { customers } from "./feature.js";
import { createCustomer } from "./operations.js";

describe("customers.create", () => {
  it("normalizes and persists through only its declared capabilities", async () => {
    const stored = new Map<string, Customer>();
    const application = createApplication({
      features: [customers],
      adapters: [
        bindPort(CustomerStorage, {
          claim: ({ id }) =>
            stored.has(id)
              ? ({
                  ok: false,
                  error: {
                    code: "CUSTOMER_ALREADY_EXISTS" as const,
                    details: { id },
                  },
                })
              : ok(true as const),
          releaseClaim: () => ok(true as const),
          get: ({ id }) => ok(stored.get(id)),
          save: (customer) => {
            stored.set(customer.id, customer);
            return ok(customer);
          },
        }),
        bindPort(CustomerClock, {
          now: () => ok("2040-01-01T00:00:00.000Z"),
        }),
      ],
      mode: "test",
    });

    const result = await testCommand({
      application,
      operation: createCustomer,
      input: {
        id: CustomerId.parse(" customer-1 "),
        name: " Ada Lovelace ",
      },
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
      "customer-storage.claim",
      "customer-clock.now",
      "customer-storage.save",
    ]);
  });
});
