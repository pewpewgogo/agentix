import { defineQuery, definePort, portOperation } from "@agentixdev/core";
import { privateCustomerState } from "../customers/model.js";

const Store = definePort({
  id: "store",
  operations: {
    save: portOperation({ id: "store.save", kind: "write" }),
  },
});

export const unsafeQuery = defineQuery({
  id: "orders.unsafe",
  input: undefined,
  output: undefined,
  errors: {},
  permissions: [],
  effects: { save: Store.save },
  emits: { changed: Changed },
  execute: async () => {
    await fetch(process.env.API_URL);
    return { ok: privateCustomerState.active };
  },
});
