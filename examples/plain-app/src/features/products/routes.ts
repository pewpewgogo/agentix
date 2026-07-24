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
        return jsonResponse(parsed, 400);
      }
      const result = await service.create(parsed.value);
      return jsonResponse(
        result.ok ? { ok: true, data: result.value } : result,
        result.ok
          ? COMMERCE_HTTP_CONTRACT.routes.createProduct.successStatus
          : COMMERCE_ERRORS.productExists.status,
      );
    },
  },
  {
    method: COMMERCE_HTTP_CONTRACT.routes.getProduct.method,
    path: COMMERCE_HTTP_CONTRACT.routes.getProduct.path,
    permission: COMMERCE_HTTP_CONTRACT.routes.getProduct.permission,
    async handle({ params }) {
      const id = normalizedPathId(params["id"]);
      if (id === undefined) return invalidInputResponse();
      const product = await service.get(id);
      return product === undefined
        ? jsonResponse(
            {
              ok: false,
              error: {
                code: COMMERCE_ERRORS.productNotFound.code,
                message: COMMERCE_ERRORS.productNotFound.message,
              },
            },
            COMMERCE_ERRORS.productNotFound.status,
          )
        : jsonResponse(
            { ok: true, data: product },
            COMMERCE_HTTP_CONTRACT.routes.getProduct.successStatus,
          );
    },
  },
];
