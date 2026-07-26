import { command, feature, port, query, s } from "@agentix/core";

export const Customer = s.object({
  id: s.string({ min: 1 }),
  name: s.string({ min: 1, trim: true }),
});
export type Customer = s.Infer<typeof Customer>;

export const CustomerStore = port.store("customerStore", Customer);

const create = command({
  input: Customer,
  output: Customer,
  errors: { CUSTOMER_ALREADY_EXISTS: { http: 409, details: { id: s.string() } } },
  http: { method: "POST", path: "/customers", status: 201 },
  effects: { load: CustomerStore.get, save: CustomerStore.save },
  async execute({ input, effects, fail }) {
    if (await effects.load(input.id)) {
      return fail("CUSTOMER_ALREADY_EXISTS", { id: input.id });
    }
    return effects.save(input);
  },
});

export const customers = feature("customers", {
  operations: {
    create,
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Customer,
      errors: { CUSTOMER_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      http: { method: "GET", path: "/customers/:id" },
      effects: { load: CustomerStore.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("CUSTOMER_NOT_FOUND", { id: input.id });
      },
    }),
  },
});

const customersContractVersion = 1;
export { customersContractVersion };
