import { command, createApplication, feature, query, s } from "@agentix/core";
import { createHttpHandler, serveNode } from "@agentix/adapters-http";

import type { HttpCondition, StartedHttpTarget } from "../types.js";

const EchoInput = s.object({ value: s.number() });
const EchoOutput = s.object({ value: s.number() });

/**
 * v2-API target. Dispatch already validates the input at the boundary and the
 * operation output before serialization; the target adds NO extra validation
 * (the v1 target's mapResponse re-parse was redundant and is gone). Responses
 * use the adapter's fixed envelope: {ok:true,value} / {ok:false,error}.
 */
const bench = feature("bench", {
  operations: {
    echo: command({
      input: EchoInput,
      output: EchoOutput,
      http: { method: "POST", path: "/echo" },
      execute({ input }) {
        return input;
      },
    }),
    item: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: s.object({ id: s.string({ min: 1 }) }),
      http: { method: "GET", path: "/items/:id" },
      execute({ input }) {
        return input;
      },
    }),
  },
});

export const stack = "agentix-node" as const;

/** Agentix always validates, so both conditions serve the identical app. */
export const start = async (
  _condition: HttpCondition,
): Promise<StartedHttpTarget> => {
  const application = createApplication({
    features: [bench],
    adapters: [],
    mode: "production",
  });
  const handler = createHttpHandler(application);
  const server = await serveNode(handler, { port: 0 });
  return Object.freeze({
    stack,
    origin: server.url,
    close: server.close,
  });
};
