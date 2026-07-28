import {
  COMMERCE_ERRORS,
  COMMERCE_HTTP_CONTRACT,
} from "@agentixdev/shared-contract";

import type { Route } from "../../http/router.js";
import {
  jsonResponse,
  domainErrorResponse,
  parseJson,
  parsePathId,
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
        return parsed.response;
      }
      const result = await service.create(parsed.value);
      return result.ok
        ? jsonResponse(
            { ok: true, value: result.value },
            COMMERCE_HTTP_CONTRACT.routes.createOrder.successStatus,
          )
        : jsonResponse(
            { ok: false, error: result.error },
            orderErrorStatus(result.error),
          );
    },
  },
  {
    method: COMMERCE_HTTP_CONTRACT.routes.getOrder.method,
    path: COMMERCE_HTTP_CONTRACT.routes.getOrder.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.getOrder.permission,
    async handle({ params }) {
      const id = parsePathId("id", params["id"]);
      if (!id.ok) return id.response;
      const order = await service.get(id.value);
      return order === undefined
        ? domainErrorResponse(COMMERCE_ERRORS.orderNotFound, { id: id.value })
        : jsonResponse(
            { ok: true, value: order },
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
        { ok: true, value: await service.events() },
        COMMERCE_HTTP_CONTRACT.routes.listEvents.successStatus,
      );
    },
  },
];
