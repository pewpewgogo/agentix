import {
  createApplication,
  defineCommand,
  defineFeature,
  defineFeatureContract,
  ok,
  schema,
} from "@agentixdev/core";
import {
  createHttpHandler,
  createNodeHttpListener,
  defineHttpRoute,
  HttpInputError,
  jsonResponse,
  readJsonBody,
} from "@agentixdev/adapters-http";

import type { HttpTarget } from "../types.js";
import {
  invalidResponse,
  startNodeTarget,
  validResponse,
} from "./shared.js";

const EchoInput = schema.object({ value: schema.number() });
const EchoOutput = schema.object({ value: schema.number() });

const echo = defineCommand({
  id: "http-comparison.echo",
  input: EchoInput,
  output: EchoOutput,
  errors: {},
  permissions: [],
  effects: {},
  emits: {},
  execute: ({ input }) => ok({ value: input.value }),
});

const echoFeature = defineFeature({
  id: "http-comparison",
  contract: defineFeatureContract({
    id: "http-comparison",
    exports: { echo },
  }),
  dependencies: [],
  operations: [echo],
  invariants: [],
});

const createListener = () => {
  const application = createApplication({
    features: [echoFeature],
    adapters: [],
    mode: "production",
  });
  const route = defineHttpRoute({
    method: "POST",
    path: "/echo",
    operation: echo,
    async mapRequest({ request }) {
      try {
        return (await readJsonBody(request)) as { value: number };
      } catch {
        throw new HttpInputError("Request body is invalid.", {
          code: "VALIDATION_ERROR",
        });
      }
    },
    mapResponse(result) {
      if (result.kind === "completed" && result.outcome.ok) {
        const output = EchoOutput.safeParse(result.outcome.value);
        if (output.success) {
          return jsonResponse(validResponse(output.data.value), 200);
        }
      }
      if (result.kind === "rejected" && result.error.code === "INVALID_INPUT") {
        return jsonResponse(invalidResponse(), 400);
      }
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "The request failed unexpectedly.",
          },
        },
        500,
      );
    },
  });
  return createNodeHttpListener(createHttpHandler({
    application,
    routes: [route],
  }));
};

export const agentixTarget: HttpTarget = Object.freeze({
  stack: "agentix-node",
  start: () => startNodeTarget("agentix-node", createListener()),
});

export const target = agentixTarget;
