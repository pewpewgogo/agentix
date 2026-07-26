import { command, feature, port, query, s } from "@agentix/core";

export const CustomerStatus = s.union([
  s.literal("active"),
  s.literal("suspended"),
]);

export const Customer = s.object({
  id: s.string({ min: 1 }),
  name: s.string({ min: 1 }),
  status: CustomerStatus,
  createdAt: s.string({ min: 1 }),
});
export type Customer = s.Infer<typeof Customer>;

export const CustomerStorage = port("customerStorage", {
  /** Atomically reserves an unused customer id; false when it already exists. */
  claim: port.write({ input: s.string({ min: 1 }), output: s.boolean() }),
  releaseClaim: port.write({ input: s.string({ min: 1 }), output: s.literal(true) }),
  get: port.read({ input: s.string({ min: 1 }), output: s.optional(Customer) }),
  save: port.write({ input: Customer, output: Customer }),
});

export const CustomerClock = port("customerClock", {
  now: port.time({ input: s.object({}), output: s.string({ min: 1 }) }),
});

export const customers = feature("customers", {
  operations: {
    create: command({
      input: s.object({
        id: s.string({ min: 1, trim: true }),
        name: s.string({ min: 1, trim: true }),
        status: s.optional(CustomerStatus),
      }),
      output: Customer,
      errors: {
        CUSTOMER_ALREADY_EXISTS: { http: 409, details: { id: s.string() } },
      },
      permissions: ["customers:create"],
      http: { method: "POST", path: "/customers", status: 201 },
      effects: {
        claim: CustomerStorage.claim,
        releaseClaim: CustomerStorage.releaseClaim,
        now: CustomerClock.now,
        save: CustomerStorage.save,
      },
      async execute({ input, effects, fail }) {
        if (!(await effects.claim(input.id))) {
          return fail("CUSTOMER_ALREADY_EXISTS", { id: input.id });
        }
        try {
          return await effects.save({
            id: input.id,
            name: input.name,
            status: input.status ?? "active",
            createdAt: await effects.now({}),
          });
        } catch (cause: unknown) {
          // Compensation: never leave a claim behind when clock/save fault.
          await effects.releaseClaim(input.id);
          throw cause;
        }
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1, trim: true }) }),
      output: Customer,
      errors: {
        CUSTOMER_NOT_FOUND: { http: 404, details: { id: s.string() } },
      },
      permissions: ["customers:read"],
      http: { method: "GET", path: "/customers/:id" },
      effects: { load: CustomerStorage.get },
      async execute({ input, effects, fail }) {
        return (
          (await effects.load(input.id)) ??
          fail("CUSTOMER_NOT_FOUND", { id: input.id })
        );
      },
    }),
  },
});
