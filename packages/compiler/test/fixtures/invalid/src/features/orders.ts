import { feature, port, query, s } from "@agentix/core";
import { privateCustomerState } from "./customers/model.js";

const Store = port("store", {
  save: port.write({ input: s.object({}), output: s.object({}) }),
});

export const orders = feature("orders", {
  operations: {
    unsafe: query({
      input: s.object({}),
      output: s.object({ state: s.boolean() }),
      effects: { save: Store.save },
      emits: { changed: Changed },
      async execute({ effects }) {
        await effects.save({});
        await fetch("https://example.com");
        const at = Date.now();
        const nonce = Math.random();
        const url = process.env["API_URL"];
        return { state: privateCustomerState.active, at, nonce, url };
      },
    }),
  },
});
