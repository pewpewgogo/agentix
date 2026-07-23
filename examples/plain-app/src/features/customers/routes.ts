import {
  COMMERCE_ERRORS,
  COMMERCE_HTTP_CONTRACT,
} from "@agentix/shared-contract";

import type { Route } from "../../http/router.js";
import {
  invalidInputResponse,
  jsonResponse,
  normalizedPathId,
  parseJson,
} from "../../http/router.js";
import { createCustomerInputSchema } from "./customer.js";
import type { CustomerService } from "./customer.js";

export const customerRoutes = (service: CustomerService): readonly Route[] => [
  {
    method: COMMERCE_HTTP_CONTRACT.routes.createCustomer.method,
    path: COMMERCE_HTTP_CONTRACT.routes.createCustomer.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.createCustomer.permission,
    async handle({ request }) {
      const parsed = await parseJson(request, createCustomerInputSchema);
      if (!parsed.ok) {
        return jsonResponse(parsed, 400);
      }
      const result = await service.create(parsed.value);
      return jsonResponse(
        result.ok ? { ok: true, data: result.value } : result,
        result.ok
          ? COMMERCE_HTTP_CONTRACT.routes.createCustomer.successStatus
          : COMMERCE_ERRORS.customerExists.status,
      );
    },
  },
  {
    method: COMMERCE_HTTP_CONTRACT.routes.getCustomer.method,
    path: COMMERCE_HTTP_CONTRACT.routes.getCustomer.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.getCustomer.permission,
    async handle({ params }) {
      const id = normalizedPathId(params["id"]);
      if (id === undefined) return invalidInputResponse();
      const customer = await service.get(id);
      return customer === undefined
        ? jsonResponse(
            {
              ok: false,
              error: {
                code: COMMERCE_ERRORS.customerNotFound.code,
                message: COMMERCE_ERRORS.customerNotFound.message,
              },
            },
            COMMERCE_ERRORS.customerNotFound.status,
          )
        : jsonResponse(
            { ok: true, data: customer },
            COMMERCE_HTTP_CONTRACT.routes.getCustomer.successStatus,
          );
    },
  },
];
