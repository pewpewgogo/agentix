import { describe, expect, it } from "vitest";
import { createApplication, feature, query, s } from "@agentix/core";
import type { AnyBoundOperation } from "@agentix/core";

import { defineHttpRoute } from "./route.js";
import { compileRouteTable, matchRoute } from "./router.js";

const echoQuery = (path: string) =>
  query({
    input: s.object({}),
    output: s.object({}),
    http: { method: "GET" as const, path },
    async execute() {
      return {};
    },
  });

const routesFeature = feature("routes", {
  operations: {
    latest: echoQuery("/notes/latest"),
    note: echoQuery("/notes/:id"),
    term: echoQuery("/search/:term"),
    cell: echoQuery("/files/:name/:section"),
    meta: echoQuery("/files/:name/meta"),
    boom: echoQuery("/boom"),
  },
});

const app = createApplication({ features: [routesFeature], adapters: [], mode: "test" });
const operations = Object.values(
  app.operations as Readonly<Record<string, AnyBoundOperation>>,
);
const table = compileRouteTable(operations);

describe("compileRouteTable", () => {
  it("buckets static routes into a map and sorts param routes static-first", () => {
    const bucket = table.buckets.get("GET");
    expect(bucket).toBeDefined();
    expect([...(bucket?.staticRoutes.keys() ?? [])].sort()).toEqual([
      "/boom",
      "/notes/latest",
    ]);
    expect(bucket?.paramRoutes.map((route) => route.path)).toEqual([
      "/files/:name/meta",
      "/notes/:id",
      "/search/:term",
      "/files/:name/:section",
    ]);
  });

  it("throws on duplicate route shapes across auto and override routes", () => {
    const clash = defineHttpRoute({
      method: "get",
      path: "/files/:x/:y",
      operation: app.operations["routes.note"],
    });
    expect(() => compileRouteTable(operations, [clash])).toThrow(/Duplicate HTTP route/);
  });

  it("drops auto routes of overridden operations", () => {
    const remapped = defineHttpRoute({
      method: "get",
      path: "/v2/notes/:id",
      operation: app.operations["routes.note"],
    });
    const rebuilt = compileRouteTable(operations, [remapped]);
    const bucket = rebuilt.buckets.get("GET");
    expect(bucket?.paramRoutes.some((route) => route.path === "/notes/:id")).toBe(false);
    expect(bucket?.paramRoutes.some((route) => route.path === "/v2/notes/:id")).toBe(true);
  });
});

describe("matchRoute", () => {
  it("matches static routes before param routes", () => {
    const match = matchRoute(table, "GET", "/notes/latest");
    expect(match.kind).toBe("matched");
    if (match.kind === "matched") expect(match.route.path).toBe("/notes/latest");
  });

  it("normalizes trailing slashes", () => {
    const match = matchRoute(table, "GET", "/notes/latest/");
    expect(match.kind).toBe("matched");
    if (match.kind === "matched") expect(match.route.path).toBe("/notes/latest");
  });

  it("gives encoded static paths a decoded second chance before params", () => {
    const match = matchRoute(table, "GET", "/notes/lates%74");
    expect(match.kind).toBe("matched");
    if (match.kind === "matched") expect(match.route.path).toBe("/notes/latest");
  });

  it("decodes param segments", () => {
    const match = matchRoute(table, "GET", "/notes/a%20b");
    expect(match.kind).toBe("matched");
    if (match.kind === "matched") expect(match.params["id"]).toBe("a b");
  });

  it("skips candidates on malformed percent-encoding instead of aborting", () => {
    expect(matchRoute(table, "GET", "/notes/%zz").kind).toBe("not_found");
    // Static raw matching still works even for paths containing malformed sequences.
    const odd = defineHttpRoute({
      method: "get",
      path: "/odd/%zz",
      operation: app.operations["routes.boom"],
    });
    const withOdd = compileRouteTable(operations, [odd]);
    expect(matchRoute(withOdd, "GET", "/odd/%zz").kind).toBe("matched");
  });

  it("prefers routes with more static segments", () => {
    const meta = matchRoute(table, "GET", "/files/readme/meta");
    expect(meta.kind).toBe("matched");
    if (meta.kind === "matched") expect(meta.route.path).toBe("/files/:name/meta");

    const cell = matchRoute(table, "GET", "/files/readme/intro");
    expect(cell.kind).toBe("matched");
    if (cell.kind === "matched") {
      expect(cell.route.path).toBe("/files/:name/:section");
      expect(cell.params).toEqual({ name: "readme", section: "intro" });
    }
  });

  it("computes the 405 Allow set lazily across other method buckets", () => {
    const result = matchRoute(table, "POST", "/notes/latest");
    expect(result).toEqual({ kind: "method_not_allowed", allow: "GET" });
    expect(matchRoute(table, "POST", "/nowhere").kind).toBe("not_found");
  });
});
