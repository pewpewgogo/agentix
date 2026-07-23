import express, { type ErrorRequestHandler } from "express";

import type { HttpTarget } from "../types.js";
import {
  invalidResponse,
  isEchoInput,
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

const createListener = () => {
  const application = express();
  application.disable("x-powered-by");

  application.post("/echo", express.json(), (request, response) => {
    if (!isEchoInput(request.body)) {
      response.status(400).json(invalidResponse());
      return;
    }
    response.status(200).json(validResponse(request.body.value));
  });

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

export const expressTarget: HttpTarget = Object.freeze({
  stack: "express",
  start: () => startNodeTarget("express", createListener()),
});

export const target = expressTarget;
