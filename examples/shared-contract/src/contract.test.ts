import { describe, expect, it } from "vitest";

import {
  COMMERCE_ERRORS,
  COMMERCE_HTTP_CONTRACT,
  COMMERCE_PERMISSIONS,
} from "./index.js";

describe("commerce contract declaration", () => {
  it("assigns one stable permission to every route", () => {
    const routes = Object.values(COMMERCE_HTTP_CONTRACT.routes);
    const permissions = Object.values(COMMERCE_PERMISSIONS);

    expect(routes.map((route) => route.permission).sort()).toEqual(
      [...permissions].sort(),
    );
    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it("uses valid HTTP status classes for every frozen response", () => {
    for (const route of Object.values(COMMERCE_HTTP_CONTRACT.routes)) {
      expect(route.successStatus).toBeGreaterThanOrEqual(200);
      expect(route.successStatus).toBeLessThan(300);
    }
    for (const error of Object.values(COMMERCE_ERRORS)) {
      expect(error.status).toBeGreaterThanOrEqual(400);
      expect(error.status).toBeLessThan(600);
      expect(error.code).toMatch(/^[A-Z][A-Z_]+$/);
      expect(error.message).toMatch(/\.$/);
    }
  });
});
