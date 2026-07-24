import {
  COMMERCE_ERRORS,
  COMMERCE_HTTP_CONTRACT,
} from "@agentixdev/shared-contract";

import type { Route } from "../../http/router.js";
import {
  invalidInputResponse,
  jsonResponse,
  normalizedPathId,
  parseJson,
} from "../../http/router.js";
import { createOrderInputSchema } from "./order.js";
import type { CreateOrderError, OrderService } from "./order.js";

const orderErrorStatus = (error: CreateOrderError): number => {
  switch (error.code) {
    case "CUSTOMER_NOT_FOUND":
      return COMMERCE_ERRORS.customerNotFound.status;
    case "PRODUCT_NOT_FOUND":
      return COMMERCE_ERRORS.productNotFound.status;
    case "PAYMENT_DECLINED":
      return COMMERCE_ERRORS.paymentDeclined.status;
    case "CUSTOMER_SUSPENDED":
      return COMMERCE_ERRORS.customerSuspended.status;
    case "OUT_OF_STOCK":
      return COMMERCE_ERRORS.outOfStock.status;
  }
};

export const orderRoutes = (service: OrderService): readonly Route[] => [
  {
    method: COMMERCE_HTTP_CONTRACT.routes.createOrder.method,
    path: COMMERCE_HTTP_CONTRACT.routes.createOrder.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.createOrder.permission,
    async handle({ request }) {
      const parsed = await parseJson(request, createOrderInputSchema);
      if (!parsed.ok) {
        return jsonResponse(parsed, 400);
      }
      const result = await service.create(parsed.value);
      return jsonResponse(
        result.ok ? { ok: true, data: result.value } : result,
        result.ok
          ? COMMERCE_HTTP_CONTRACT.routes.createOrder.successStatus
          : orderErrorStatus(result.error),
      );
    },
  },
  {
    method: COMMERCE_HTTP_CONTRACT.routes.getOrder.method,
    path: COMMERCE_HTTP_CONTRACT.routes.getOrder.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.getOrder.permission,
    async handle({ params }) {
      const id = normalizedPathId(params["id"]);
      if (id === undefined) return invalidInputResponse();
      const order = await service.get(id);
      return order === undefined
        ? jsonResponse(
            {
              ok: false,
              error: {
                code: COMMERCE_ERRORS.orderNotFound.code,
                message: COMMERCE_ERRORS.orderNotFound.message,
              },
            },
            COMMERCE_ERRORS.orderNotFound.status,
          )
        : jsonResponse(
            { ok: true, data: order },
            COMMERCE_HTTP_CONTRACT.routes.getOrder.successStatus,
          );
    },
  },
  {
    method: COMMERCE_HTTP_CONTRACT.routes.listEvents.method,
    path: COMMERCE_HTTP_CONTRACT.routes.listEvents.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.listEvents.permission,
    async handle() {
      return jsonResponse(
        { ok: true, data: await service.events() },
        COMMERCE_HTTP_CONTRACT.routes.listEvents.successStatus,
      );
    },
  },
];
