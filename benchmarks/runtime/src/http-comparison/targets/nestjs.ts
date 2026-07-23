import "reflect-metadata";

import type { Server } from "node:http";

import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  HttpCode,
  HttpException,
  Module,
  Post,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import type { HttpTarget, StartedHttpTarget } from "../types.js";
import {
  invalidResponse,
  isEchoInput,
  validResponse,
} from "./shared.js";

const routeNotFoundResponse = (): unknown => ({
  ok: false,
  error: {
    code: "ROUTE_NOT_FOUND",
    message: "Route not found.",
  },
});

const internalErrorResponse = (): unknown => ({
  ok: false,
  error: {
    code: "INTERNAL_ERROR",
    message: "The request failed unexpectedly.",
  },
});

interface JsonHttpResponse {
  status(statusCode: number): JsonHttpResponse;
  json(body: unknown): void;
}

const numericStatus = (exception: unknown): number | undefined => {
  if (exception instanceof HttpException) return exception.getStatus();
  if (typeof exception !== "object" || exception === null) return undefined;
  for (const key of ["status", "statusCode"] as const) {
    const value = Reflect.get(exception, key);
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
};

class StableHttpExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<JsonHttpResponse>();
    const status = numericStatus(exception);
    if (status === 400 || exception instanceof BadRequestException) {
      response.status(400).json(invalidResponse());
      return;
    }
    if (status === 404) {
      response.status(404).json(routeNotFoundResponse());
      return;
    }
    response.status(500).json(internalErrorResponse());
  }
}

// Calling the legacy Nest decorators directly keeps this benchmark target
// self-contained and avoids changing the runtime package's compiler settings.
Catch()(StableHttpExceptionFilter);

class EchoController {
  public echo(body: unknown): unknown {
    if (!isEchoInput(body)) throw new BadRequestException();
    return validResponse(body.value);
  }
}

Body()(EchoController.prototype, "echo", 0);
const echoDescriptor = Object.getOwnPropertyDescriptor(
  EchoController.prototype,
  "echo",
);
if (echoDescriptor === undefined) {
  throw new Error("NestJS echo controller descriptor is unavailable.");
}
HttpCode(200)(EchoController.prototype, "echo", echoDescriptor);
Post("echo")(EchoController.prototype, "echo", echoDescriptor);
Controller()(EchoController);

class EchoModule {}

Module({ controllers: [EchoController] })(EchoModule);

const serverPort = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("NestJS HTTP comparison server returned no TCP address.");
  }
  return address.port;
};

export const nestjsTarget: HttpTarget = Object.freeze({
  stack: "nestjs-express",
  async start(): Promise<StartedHttpTarget> {
    const app = await NestFactory.create(EchoModule, { logger: false });
    app.useGlobalFilters(new StableHttpExceptionFilter());
    try {
      await app.listen(0, "127.0.0.1");
    } catch (cause: unknown) {
      await app.close().catch(() => undefined);
      throw cause;
    }

    const server = app.getHttpServer() as Server;
    let closed = false;
    return Object.freeze({
      stack: "nestjs-express",
      origin: `http://127.0.0.1:${serverPort(server)}`,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        await app.close();
      },
    });
  },
});

export const target = nestjsTarget;
