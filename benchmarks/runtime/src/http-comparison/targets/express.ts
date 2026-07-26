import express, { type ErrorRequestHandler } from "express";

import type { HttpCondition, StartedHttpTarget } from "../types.js";
import {
  EchoInputZod,
  EchoOutputZod,
  ParamInputZod,
  ParamOutputZod,
  invalidResponse,
  isEchoInput,
  paramResponse,
  startNodeTarget,
  validResponse,
} from "./shared.js";

const routeNotFoundResponse = (): unknown => ({
  ok: false,
  error: {
    code: "ROUTE_NOT_FOUND",
    message: "Route not found.",
  },
});

/**
 * In the "default" condition the echo route is byte-identical to the v1
 * target. The "validated" condition adds zod input AND output validation,
 * matching the boundary work Agentix always performs.
 */
const createListener = (condition: HttpCondition) => {
  const application = express();
  application.disable("x-powered-by");

  if (condition === "validated") {
    application.post("/echo", express.json(), (request, response) => {
      const input = EchoInputZod.safeParse(request.body);
      if (!input.success) {
        response.status(400).json(invalidResponse());
        return;
      }
      const output = EchoOutputZod.parse({ value: input.data.value });
      response.status(200).json(validResponse(output.value));
    });
    application.get("/items/:id", (request, response) => {
      const input = ParamInputZod.safeParse({ id: request.params.id });
      if (!input.success) {
        response.status(400).json(invalidResponse());
        return;
      }
      const output = ParamOutputZod.parse({ id: input.data.id });
      response.status(200).json(paramResponse(output.id));
    });
  } else {
    application.post("/echo", express.json(), (request, response) => {
      if (!isEchoInput(request.body)) {
        response.status(400).json(invalidResponse());
        return;
      }
      response.status(200).json(validResponse(request.body.value));
    });
    application.get("/items/:id", (request, response) => {
      response.status(200).json(paramResponse(request.params.id));
    });
  }

  application.use((_request, response) => {
    response.status(404).json(routeNotFoundResponse());
  });

  const invalidJson: ErrorRequestHandler = (
    _error,
    _request,
    response,
    _next,
  ) => {
    response.status(400).json(invalidResponse());
  };
  application.use(invalidJson);

  return application;
};

export const stack = "express" as const;

export const start = (condition: HttpCondition): Promise<StartedHttpTarget> =>
  startNodeTarget("express", createListener(condition));
