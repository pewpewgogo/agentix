import { describe, expect, expectTypeOf, it } from "vitest";

import {
  bindPort,
  defineCommand,
  defineEvent,
  defineFeature,
  defineFeatureContract,
  defineInvariant,
  definePort,
  defineQuery,
  domainError,
  err,
  ok,
  portOperation,
  schema,
  type DeclaredError,
  type Infer,
  type PortImplementation,
} from "../src/index.js";

const KeyValue = definePort({
  id: "key-value",
  operations: {
    get: portOperation({
      id: "key-value.get",
      kind: "read",
      input: schema.object({ key: schema.string() }),
      output: schema.optional(schema.string()),
      errors: {},
    }),
    put: portOperation({
      id: "key-value.put",
      kind: "write",
      input: schema.object({ key: schema.string(), value: schema.string() }),
      output: schema.literal(true),
      errors: {
        UNAVAILABLE: schema.object({ retryable: schema.boolean() }),
      },
    }),
  },
});

describe("descriptors", () => {
  it("makes each port operation independently referenceable", () => {
    expect(KeyValue).toMatchObject({ descriptorType: "port", id: "key-value" });
    expect(KeyValue.operations.get).toMatchObject({
      id: "key-value.get",
      kind: "read",
      portId: "key-value",
      operationKey: "get",
    });
    expect(Object.isFrozen(KeyValue.operations)).toBe(true);
  });

  it("types complete adapter implementations with Outcomes", () => {
    const implementation: PortImplementation<typeof KeyValue> = {
      get: ({ key }) => ok(key === "known" ? "value" : undefined),
      put: ({ key }) =>
        key === "fail"
          ? err(domainError("UNAVAILABLE", { retryable: true }))
          : ok(true as const),
    };
    const adapter = bindPort(KeyValue, implementation);
    expect(adapter.port).toBe(KeyValue);
    expect(Object.isFrozen(adapter.operations)).toBe(true);
  });

  it("infers command input, effects, emitters, output, and declared errors", async () => {
    const Changed = defineEvent({
      id: "values.changed",
      version: 1,
      payload: schema.object({ key: schema.string() }),
    });
    const command = defineCommand({
      id: "values.set",
      input: schema.object({ key: schema.string(), value: schema.string() }),
      output: schema.literal(true),
      errors: {
        SAVE_FAILED: schema.object({ key: schema.string() }),
      },
      permissions: ["values:write"],
      effects: { save: KeyValue.operations.put },
      emits: { changed: Changed },
      async execute({ input, effects, emit }) {
        expectTypeOf(input).toEqualTypeOf<{ key: string; value: string }>();
        const saved = await effects.save(input);
        if (!saved.ok) {
          return err(domainError("SAVE_FAILED", { key: input.key }));
        }
        emit.changed({ key: input.key });
        return ok(true as const);
      },
    });

    type Error = DeclaredError<typeof command.errors>;
    expectTypeOf<Error>().toEqualTypeOf<{
      readonly code: "SAVE_FAILED";
      readonly details: { key: string };
    }>();
    expect(command.kind).toBe("command");
    expect(command.effects.save).toBe(KeyValue.operations.put);
  });

  it("defines read-only queries and explicit feature capsules", () => {
    const getValue = defineQuery({
      id: "values.get",
      input: schema.object({ key: schema.string() }),
      output: schema.optional(schema.string()),
      errors: {},
      permissions: ["values:read"],
      effects: { get: KeyValue.operations.get },
      execute: async ({ input, effects }) => effects.get(input),
    });
    const contract = defineFeatureContract({
      id: "values",
      exports: { getValue },
    });
    const invariant = defineInvariant({
      id: "values.non-empty-key",
      dependsOn: [contract],
      evidence: schema.object({ key: schema.string() }),
      check: ({ key }) => key.length > 0,
    });
    const capsule = defineFeature({
      id: "values",
      contract,
      dependencies: [],
      operations: [getValue],
      invariants: [invariant],
      ports: [KeyValue],
    });

    expect(capsule).toMatchObject({
      descriptorType: "feature",
      id: "values",
      operations: [getValue],
      invariants: [invariant],
    });
    expect(invariant.check({ key: "x" })).toBe(true);
    expect(Object.isFrozen(capsule)).toBe(true);
  });

  it("rejects invalid local descriptor consistency", () => {
    expect(() =>
      defineFeature({
        id: "wrong",
        contract: defineFeatureContract({ id: "other" }),
        dependencies: [],
        operations: [],
        invariants: [],
      }),
    ).toThrow(/same id/);

    expect(() =>
      defineCommand({
        id: "duplicate.permissions",
        input: schema.object({}),
        output: schema.literal(true),
        errors: {},
        permissions: ["same", "same"],
        effects: {},
        emits: {},
        execute: () => ok(true as const),
      }),
    ).toThrow(/Duplicate permission/);
  });
});
