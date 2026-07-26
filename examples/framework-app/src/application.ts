import {
  createHttpHandler,
  createTrustedHeaderPrincipalExtractor,
} from "@agentix/adapters-http";
import { createApplication } from "@agentix/core";
import {
  COMMERCE_HTTP_CONTRACT,
  type CommerceSystem,
  type CommerceSystemOptions,
} from "@agentix/shared-contract";

import { cloneSnapshot, commerceAdapters, createState } from "./adapters.js";
import { customers } from "./features/customers.js";
import { orders } from "./features/orders.js";
import { payments } from "./features/payments.js";
import { products } from "./features/products.js";

export interface FrameworkSystemOptions extends CommerceSystemOptions {
  /** Acceptance runs both: "test" keeps dev checks on, "production" is the fast path. */
  readonly mode?: "test" | "production";
}

/** Missing/blank principal header => anonymous request => opaque 403 on permissioned operations. */
const authenticate = createTrustedHeaderPrincipalExtractor({
  idHeader: COMMERCE_HTTP_CONTRACT.authentication.principalHeader,
  permissionsHeader: COMMERCE_HTTP_CONTRACT.authentication.permissionsHeader,
  separator: COMMERCE_HTTP_CONTRACT.authentication.permissionsSeparator,
});

export const createFrameworkSystem = (
  options: FrameworkSystemOptions = {},
): CommerceSystem => {
  const state = createState();
  const application = createApplication({
    features: [customers, products, payments, orders],
    adapters: commerceAdapters(state, options),
    mode: options.mode ?? "test",
  });
  const handler = createHttpHandler(application, { authenticate });

  return {
    handle: handler.fetch,
    snapshot: async () => cloneSnapshot(state),
  };
};
