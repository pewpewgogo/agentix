import {
  defineFeatureContract,
  definePort,
  portOperation,
  schema,
  type Infer,
} from "@agentix/core";

export const CustomerId = schema.id("customer");
export const Customer = schema.object({
  id: CustomerId,
  name: schema.refine(schema.string(), (value) => value.trim().length > 0, {
    id: "customer-name",
    message: "Customer name must not be empty",
  }),
  status: schema.union([schema.literal("active"), schema.literal("suspended")]),
  createdAt: schema.string(),
});

export type Customer = Infer<typeof Customer>;

export const CustomerStorage = definePort({
  id: "customer-storage",
  operations: {
    claim: portOperation({
      id: "customer-storage.claim",
      kind: "write",
      input: schema.object({ id: CustomerId }),
      output: schema.literal(true),
      errors: {
        CUSTOMER_ALREADY_EXISTS: schema.object({ id: CustomerId }),
      },
    }),
    releaseClaim: portOperation({
      id: "customer-storage.release-claim",
      kind: "write",
      input: schema.object({ id: CustomerId }),
      output: schema.literal(true),
      errors: {},
    }),
    get: portOperation({
      id: "customer-storage.get",
      kind: "read",
      input: schema.object({ id: CustomerId }),
      output: schema.optional(Customer),
      errors: {},
    }),
    save: portOperation({
      id: "customer-storage.save",
      kind: "write",
      input: Customer,
      output: Customer,
      errors: {
        CUSTOMER_ALREADY_EXISTS: schema.object({ id: CustomerId }),
      },
    }),
  },
});

export const CustomerClock = definePort({
  id: "customer-clock",
  operations: {
    now: portOperation({
      id: "customer-clock.now",
      kind: "time",
      input: schema.object({}),
      output: schema.string(),
      errors: {},
    }),
  },
});

export const customersContract = defineFeatureContract({
  id: "customers",
  exports: {
    Customer,
    CustomerId,
    CustomerStorage,
    CustomerClock,
  },
});
