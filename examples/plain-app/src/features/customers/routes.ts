import {
  COMMERCE_ERRORS,
  COMMERCE_HTTP_CONTRACT,
} from "@agentixdev/shared-contract";

import type { Route } from "../../http/router.js";
import {
  domainErrorResponse,
  jsonResponse,
  parseJson,
  parsePathId,
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
        return parsed.response;
      }
      const result = await service.create(parsed.value);
      return result.ok
        ? jsonResponse(
            { ok: true, value: result.value },
            COMMERCE_HTTP_CONTRACT.routes.createCustomer.successStatus,
          )
        : domainErrorResponse(
            COMMERCE_ERRORS.customerExists,
            result.error.details,
          );
    },
  },
  {
    method: COMMERCE_HTTP_CONTRACT.routes.getCustomer.method,
    path: COMMERCE_HTTP_CONTRACT.routes.getCustomer.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.getCustomer.permission,
    async handle({ params }) {
      const id = parsePathId("id", params["id"]);
      if (!id.ok) return id.response;
      const customer = await service.get(id.value);
      return customer === undefined
        ? domainErrorResponse(COMMERCE_ERRORS.customerNotFound, {
            id: id.value,
          })
        : jsonResponse(
            { ok: true, value: customer },
            COMMERCE_HTTP_CONTRACT.routes.getCustomer.successStatus,
          );
    },
  },
];
