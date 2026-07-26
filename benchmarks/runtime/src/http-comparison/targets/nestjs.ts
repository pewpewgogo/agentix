import "reflect-metadata";

import type { Server } from "node:http";

import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Module,
  Param,
  Post,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import type { HttpCondition, StartedHttpTarget } from "../types.js";
import {
  EchoInputZod,
  EchoOutputZod,
  ParamInputZod,
  ParamOutputZod,
  invalidResponse,
  isEchoInput,
  paramResponse,
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

interface EchoControllerShape {
  echo(body: unknown): unknown;
  item(id: string): unknown;
}

/** In the "default" condition echo behavior is byte-identical to v1. */
class EchoController implements EchoControllerShape {
  public echo(body: unknown): unknown {
    if (!isEchoInput(body)) throw new BadRequestException();
    return validResponse(body.value);
  }

  public item(id: string): unknown {
    return paramResponse(id);
  }
}

/** "validated": zod input AND output validation, equal work to Agentix. */
class ValidatedEchoController implements EchoControllerShape {
  public echo(body: unknown): unknown {
    const input = EchoInputZod.safeParse(body);
    if (!input.success) throw new BadRequestException();
    const output = EchoOutputZod.parse({ value: input.data.value });
    return validResponse(output.value);
  }

  public item(id: string): unknown {
    const input = ParamInputZod.safeParse({ id });
    if (!input.success) throw new BadRequestException();
    const output = ParamOutputZod.parse({ id: input.data.id });
    return paramResponse(output.id);
  }
}

const decorateEchoController = (
  controller: new () => EchoControllerShape,
): void => {
  Body()(controller.prototype, "echo", 0);
  const echoDescriptor = Object.getOwnPropertyDescriptor(
    controller.prototype,
    "echo",
  );
  if (echoDescriptor === undefined) {
    throw new Error("NestJS echo controller descriptor is unavailable.");
  }
  HttpCode(200)(controller.prototype, "echo", echoDescriptor);
  Post("echo")(controller.prototype, "echo", echoDescriptor);

  Param("id")(controller.prototype, "item", 0);
  const itemDescriptor = Object.getOwnPropertyDescriptor(
    controller.prototype,
    "item",
  );
  if (itemDescriptor === undefined) {
    throw new Error("NestJS item controller descriptor is unavailable.");
  }
  HttpCode(200)(controller.prototype, "item", itemDescriptor);
  Get("items/:id")(controller.prototype, "item", itemDescriptor);

  Controller()(controller);
};

decorateEchoController(EchoController);
decorateEchoController(ValidatedEchoController);

class EchoModule {}
class ValidatedEchoModule {}

Module({ controllers: [EchoController] })(EchoModule);
Module({ controllers: [ValidatedEchoController] })(ValidatedEchoModule);

const serverPort = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("NestJS HTTP comparison server returned no TCP address.");
  }
  return address.port;
};

export const stack = "nestjs-express" as const;

export const start = async (
  condition: HttpCondition,
): Promise<StartedHttpTarget> => {
  const module = condition === "validated" ? ValidatedEchoModule : EchoModule;
  const app = await NestFactory.create(module, { logger: false });
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
    stack,
    origin: `http://127.0.0.1:${serverPort(server)}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await app.close();
    },
  });
};
