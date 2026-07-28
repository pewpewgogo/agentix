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
import { createProductInputSchema } from "./product.js";
import type { ProductService } from "./product.js";

export const productRoutes = (service: ProductService): readonly Route[] => [
  {
    method: COMMERCE_HTTP_CONTRACT.routes.createProduct.method,
    path: COMMERCE_HTTP_CONTRACT.routes.createProduct.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.createProduct.permission,
    async handle({ request }) {
      const parsed = await parseJson(request, createProductInputSchema);
      if (!parsed.ok) {
        return parsed.response;
      }
      const result = await service.create(parsed.value);
      return result.ok
        ? jsonResponse(
            { ok: true, value: result.value },
            COMMERCE_HTTP_CONTRACT.routes.createProduct.successStatus,
          )
        : domainErrorResponse(
            COMMERCE_ERRORS.productExists,
            result.error.details,
          );
    },
  },
  {
    method: COMMERCE_HTTP_CONTRACT.routes.getProduct.method,
    path: COMMERCE_HTTP_CONTRACT.routes.getProduct.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.getProduct.permission,
    async handle({ params }) {
      const id = parsePathId("id", params["id"]);
      if (!id.ok) return id.response;
      const product = await service.get(id.value);
      return product === undefined
        ? domainErrorResponse(COMMERCE_ERRORS.productNotFound, { id: id.value })
        : jsonResponse(
            { ok: true, value: product },
            COMMERCE_HTTP_CONTRACT.routes.getProduct.successStatus,
          );
    },
  },
];
