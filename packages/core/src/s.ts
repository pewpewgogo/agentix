/**
 * Schema namespace facade. Re-exported from the package index as
 * `export * as s`, giving both `s.string()` values and `s.Infer<...>` types.
 */
export {
  array,
  boolean,
  id,
  literal,
  number,
  object,
  optional,
  record,
  refine,
  string,
  tuple,
  union,
} from "./schema.js";
export type {
  BrandedId,
  Infer,
  NumberOptions,
  ObjectOutput,
  ObjectSchema,
  OptionalSchema,
  RefinementOptions,
  Schema,
  SchemaShape,
  StringOptions,
  TupleOutput,
} from "./schema.js";
