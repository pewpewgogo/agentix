import {
  bindPort,
  defineCommand,
  defineEvent,
  definePort,
  defineQuery,
  ok,
  portOperation,
  schema,
  type BrandedId,
  type Infer,
} from "../src/index.js";

const UserId = schema.id("user");
type UserId = Infer<typeof UserId>;
const validId: UserId = UserId.parse("user-1");
const branded: BrandedId<"user"> = validId;
void branded;
// @ts-expect-error Plain strings do not silently acquire an ID brand.
const invalidId: UserId = "user-1";
void invalidId;

const Port = definePort({
  id: "types.port",
  operations: {
    read: portOperation({
      id: "types.port.read",
      kind: "read",
      input: schema.object({ id: UserId }),
      output: schema.string(),
      errors: {},
    }),
    write: portOperation({
      id: "types.port.write",
      kind: "write",
      input: schema.object({ id: UserId, value: schema.string() }),
      output: schema.literal(true),
      errors: {},
    }),
  },
});

const Changed = defineEvent({
  id: "types.changed",
  version: 1,
  payload: schema.object({ id: UserId }),
});

defineCommand({
  id: "types.command",
  input: schema.object({ id: UserId }),
  output: schema.string(),
  errors: {},
  permissions: [],
  effects: { load: Port.operations.read },
  emits: { changed: Changed },
  async execute({ input, effects, emit }) {
    const value = await effects.load({ id: input.id });
    emit.changed({ id: input.id });
    // @ts-expect-error The context exposes only declared effect aliases.
    await effects.write({ id: input.id, value: "hidden" });
    // @ts-expect-error Event payloads are schema-inferred.
    emit.changed({ id: "not-branded" });
    return value;
  },
});

defineQuery({
  id: "types.query",
  input: schema.object({ id: UserId }),
  output: schema.string(),
  errors: {},
  permissions: [],
  effects: { load: Port.operations.read },
  execute: async ({ input, effects }) => effects.load({ id: input.id }),
});

defineQuery({
  id: "types.invalid-query",
  input: schema.object({ id: UserId }),
  output: schema.literal(true),
  errors: {},
  permissions: [],
  // @ts-expect-error Queries cannot declare write effects.
  effects: { save: Port.operations.write },
  execute: async () => ok(true as const),
});

bindPort(Port, {
  read: () => ok("value"),
  write: () => ok(true as const),
});

// @ts-expect-error A bound adapter must implement the complete port contract.
bindPort(Port, { read: () => ok("value") });
