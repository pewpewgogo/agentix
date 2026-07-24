import {
  defineCommand,
  defineQuery,
  domainError,
  err,
  ok,
  schema,
} from "@agentixdev/core";

import {
  Customer,
  CustomerClock,
  CustomerId,
  CustomerStorage,
} from "./contract.js";

const CustomerStatus = schema.union([
  schema.literal("active"),
  schema.literal("suspended"),
]);

export const createCustomer = defineCommand({
  id: "customers.create",
  input: schema.object({
    id: schema.refine(CustomerId, (value) => value.trim().length > 0, {
      id: "customer-input-id",
      message: "Customer ID must not be blank",
    }),
    name: schema.refine(schema.string(), (value) => value.trim().length > 0, {
      id: "customer-input-name",
      message: "Customer name must not be blank",
    }),
    status: schema.optional(CustomerStatus),
  }),
  output: Customer,
  errors: {
    CUSTOMER_ALREADY_EXISTS: schema.object({ id: CustomerId }),
  },
  permissions: ["customers:create"],
  effects: {
    claim: CustomerStorage.operations.claim,
    releaseClaim: CustomerStorage.operations.releaseClaim,
    now: CustomerClock.operations.now,
    save: CustomerStorage.operations.save,
  },
  emits: {},
  async execute({ input, effects }) {
    const id = CustomerId.parse(input.id.trim());
    const claimed = await effects.claim({ id });
    if (!claimed.ok) {
      return err(domainError("CUSTOMER_ALREADY_EXISTS", { id }));
    }
    try {
      const timeResult = await effects.now({});
      if (!timeResult.ok) {
        const released = await effects.releaseClaim({ id });
        return released.ok ? timeResult : released;
      }
      const customer = Customer.parse({
        id,
        name: input.name.trim(),
        status: input.status ?? "active",
        createdAt: timeResult.value,
      });
      const saved = await effects.save(customer);
      if (!saved.ok) {
        const released = await effects.releaseClaim({ id });
        return released.ok ? saved : released;
      }
      return ok(customer);
    } catch (cause: unknown) {
      await effects.releaseClaim({ id });
      throw cause;
    }
  },
});

export const getCustomer = defineQuery({
  id: "customers.get",
  input: schema.object({ id: CustomerId }),
  output: Customer,
  errors: {
    CUSTOMER_NOT_FOUND: schema.object({ id: CustomerId }),
  },
  permissions: ["customers:read"],
  effects: { load: CustomerStorage.operations.get },
  async execute({ input, effects }) {
    const loaded = await effects.load(input);
    if (!loaded.ok) return loaded;
    return loaded.value === undefined
      ? err(domainError("CUSTOMER_NOT_FOUND", { id: input.id }))
      : ok(loaded.value);
  },
});
