export type SchemaPathSegment = string | number;

export type SchemaIssueCode =
  | "invalid_type"
  | "invalid_number"
  | "invalid_literal"
  | "required"
  | "unexpected_key"
  | "invalid_union"
  | "refinement_failed"
  | "invalid_id";

export interface SchemaIssue {
  readonly code: SchemaIssueCode;
  readonly path: readonly SchemaPathSegment[];
  readonly message: string;
  readonly causes?: readonly SchemaIssue[];
}

export type LiteralValue = string | number | boolean | null;

export type SchemaDescription =
  | { readonly type: "string" }
  | { readonly type: "number" }
  | { readonly type: "boolean" }
  | { readonly type: "literal"; readonly value: LiteralValue }
  | { readonly type: "array"; readonly item: SchemaDescription }
  | {
      readonly type: "object";
      readonly fields: Readonly<Record<string, SchemaDescription>>;
    }
  | { readonly type: "optional"; readonly inner: SchemaDescription }
  | {
      readonly type: "union";
      readonly options: readonly SchemaDescription[];
    }
  | {
      readonly type: "refinement";
      readonly id: string;
      readonly base: SchemaDescription;
    }
  | { readonly type: "id"; readonly brand: string };

export interface ParseSuccess<T> {
  readonly success: true;
  readonly data: T;
}

export interface ParseFailure {
  readonly success: false;
  readonly issues: readonly SchemaIssue[];
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

export interface Schema<T> {
  readonly description: SchemaDescription;
  parse(value: unknown): T;
  safeParse(value: unknown): ParseResult<T>;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
  readonly inner: Schema<T>;
}

export type Infer<S extends Schema<unknown>> =
  S extends Schema<infer T> ? T : never;

export const ID_BRAND: unique symbol = Symbol("agentix.id-brand");

export type BrandedId<Brand extends string> = string & {
  readonly [ID_BRAND]: Brand;
};

export class SchemaValidationError extends TypeError {
  readonly issues: readonly SchemaIssue[];

  constructor(issues: readonly SchemaIssue[]) {
    super(formatIssues(issues));
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

type Parser<T> = (
  value: unknown,
  path: readonly SchemaPathSegment[],
) => ParseResult<T>;

const success = <T>(data: T): ParseSuccess<T> =>
  Object.freeze({ success: true, data });

const failure = (...issues: readonly SchemaIssue[]): ParseFailure =>
  Object.freeze({ success: false, issues: Object.freeze([...issues]) });

const issue = (
  code: SchemaIssueCode,
  path: readonly SchemaPathSegment[],
  message: string,
  causes?: readonly SchemaIssue[],
): SchemaIssue => {
  const base = {
    code,
    path: Object.freeze([...path]),
    message,
  };
  return Object.freeze(
    causes === undefined
      ? base
      : { ...base, causes: Object.freeze([...causes]) },
  );
};

const createSchema = <T>(
  description: SchemaDescription,
  parser: Parser<T>,
): Schema<T> => {
  const safeParse = (value: unknown): ParseResult<T> => parser(value, []);
  return Object.freeze({
    description,
    safeParse,
    parse(value: unknown): T {
      const result = safeParse(value);
      if (result.success) {
        return result.data;
      }
      throw new SchemaValidationError(result.issues);
    },
  });
};

const describeValue = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isNaN(value)) return "NaN";
  return typeof value;
};

export const string = (): Schema<string> =>
  createSchema(Object.freeze({ type: "string" }), (value, path) =>
    typeof value === "string"
      ? success(value)
      : failure(
          issue(
            "invalid_type",
            path,
            `Expected string, received ${describeValue(value)}`,
          ),
        ),
  );

export const number = (): Schema<number> =>
  createSchema(Object.freeze({ type: "number" }), (value, path) => {
    if (typeof value !== "number") {
      return failure(
        issue(
          "invalid_type",
          path,
          `Expected number, received ${describeValue(value)}`,
        ),
      );
    }
    return Number.isFinite(value)
      ? success(value)
      : failure(issue("invalid_number", path, "Expected a finite number"));
  });

export const boolean = (): Schema<boolean> =>
  createSchema(Object.freeze({ type: "boolean" }), (value, path) =>
    typeof value === "boolean"
      ? success(value)
      : failure(
          issue(
            "invalid_type",
            path,
            `Expected boolean, received ${describeValue(value)}`,
          ),
        ),
  );

export const literal = <const T extends LiteralValue>(value: T): Schema<T> =>
  createSchema(Object.freeze({ type: "literal", value }), (input, path) =>
    Object.is(input, value)
      ? success(value)
      : failure(
          issue(
            "invalid_literal",
            path,
            `Expected literal ${JSON.stringify(value)}`,
          ),
        ),
  );

export const array = <S extends Schema<unknown>>(
  item: S,
): Schema<readonly Infer<S>[]> =>
  createSchema<readonly Infer<S>[]>(
    Object.freeze({ type: "array", item: item.description }),
    (value, path) => {
      if (!Array.isArray(value)) {
        return failure(
          issue(
            "invalid_type",
            path,
            `Expected array, received ${describeValue(value)}`,
          ),
        );
      }

      const parsed: Infer<S>[] = [];
      const issues: SchemaIssue[] = [];
      value.forEach((entry, index) => {
        const result = parseAt(item, entry, [...path, index]);
        if (result.success) parsed.push(result.data);
        else issues.push(...result.issues);
      });
      return issues.length > 0 ? failure(...issues) : success(Object.freeze(parsed));
    },
  );

type SchemaShape = Readonly<Record<string, Schema<unknown>>>;
type OptionalKey<S extends SchemaShape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];
type RequiredKey<S extends SchemaShape> = Exclude<keyof S, OptionalKey<S>>;
type OptionalValue<S extends Schema<unknown>> =
  S extends OptionalSchema<infer T> ? T : Infer<S>;
type Simplify<T> = { [K in keyof T]: T[K] };

export type ObjectOutput<S extends SchemaShape> = Simplify<
  {
    -readonly [K in RequiredKey<S>]: Infer<S[K]>;
  } & {
    -readonly [K in OptionalKey<S>]?: OptionalValue<S[K]>;
  }
>;

export const object = <const S extends SchemaShape>(
  shape: S,
): Schema<ObjectOutput<S>> => {
  const shapeSnapshot = Object.freeze({ ...shape }) as S;
  const keys = Object.keys(shapeSnapshot).sort();
  const fields = Object.freeze(
    Object.fromEntries(keys.map((key) => [key, shapeSnapshot[key]?.description])),
  ) as Readonly<Record<string, SchemaDescription>>;

  return createSchema(
    Object.freeze({ type: "object", fields }),
    (value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return failure(
          issue(
            "invalid_type",
            path,
            `Expected object, received ${describeValue(value)}`,
          ),
        );
      }

      const source = value as Record<string, unknown>;
      const parsed: Record<string, unknown> = {};
      const issues: SchemaIssue[] = [];

      for (const key of keys) {
        const field = shapeSnapshot[key];
        if (field === undefined) continue;
        const present = Object.prototype.hasOwnProperty.call(source, key);
        if (!present && isOptionalSchema(field)) continue;
        if (!present) {
          issues.push(issue("required", [...path, key], "Required field is missing"));
          continue;
        }
        const result = parseAt(field, source[key], [...path, key]);
        if (result.success) parsed[key] = result.data;
        else issues.push(...result.issues);
      }

      for (const key of Object.keys(source).sort()) {
        if (!Object.prototype.hasOwnProperty.call(shapeSnapshot, key)) {
          issues.push(
            issue("unexpected_key", [...path, key], `Unexpected key ${JSON.stringify(key)}`),
          );
        }
      }

      return issues.length > 0
        ? failure(...issues)
        : success(parsed as ObjectOutput<S>);
    },
  );
};

export const optional = <S extends Schema<unknown>>(
  inner: S,
): OptionalSchema<Infer<S>> => {
  const base = createSchema<Infer<S> | undefined>(
    Object.freeze({ type: "optional", inner: inner.description }),
    (value, path) =>
      value === undefined ? success(undefined) : parseAt(inner, value, path),
  );
  return Object.freeze({
    ...base,
    optional: true,
    inner: inner as Schema<Infer<S>>,
  });
};

export const union = <const S extends readonly [Schema<unknown>, ...Schema<unknown>[]]>(
  options: S,
): Schema<Infer<S[number]>> => {
  const optionsSnapshot = Object.freeze([...options]) as unknown as S;
  return createSchema(
    Object.freeze({
      type: "union",
      options: Object.freeze(optionsSnapshot.map((option) => option.description)),
    }),
    (value, path) => {
      const causes: SchemaIssue[] = [];
      for (const option of optionsSnapshot) {
        const result = parseAt(option, value, path);
        if (result.success) return result as ParseSuccess<Infer<S[number]>>;
        causes.push(...result.issues);
      }
      return failure(
        issue("invalid_union", path, "Value did not match any union option", causes),
      );
    },
  );
};

export interface RefinementOptions {
  readonly id: string;
  readonly message: string;
}

export const refine = <S extends Schema<unknown>>(
  base: S,
  predicate: (value: Infer<S>) => boolean,
  options: RefinementOptions | string,
): Schema<Infer<S>> => {
  const normalized =
    typeof options === "string" ? { id: options, message: options } : options;
  if (normalized.id.length === 0) {
    throw new TypeError("Refinement id must not be empty");
  }

  return createSchema<Infer<S>>(
    Object.freeze({
      type: "refinement",
      id: normalized.id,
      base: base.description,
    }),
    (value, path) => {
      const parsed = parseAt(base, value, path);
      if (!parsed.success) return parsed;
      try {
        return predicate(parsed.data)
          ? parsed
          : failure(issue("refinement_failed", path, normalized.message));
      } catch {
        return failure(issue("refinement_failed", path, normalized.message));
      }
    },
  );
};

export const id = <const Brand extends string>(
  brand: Brand,
): Schema<BrandedId<Brand>> => {
  if (brand.length === 0) throw new TypeError("ID brand must not be empty");
  return createSchema(
    Object.freeze({ type: "id", brand }),
    (value, path) =>
      typeof value === "string" && value.length > 0
        ? success(value as BrandedId<Brand>)
        : failure(
            issue("invalid_id", path, `Expected a non-empty ${brand} id`),
          ),
  );
};

const isOptionalSchema = (value: Schema<unknown>): value is OptionalSchema<unknown> =>
  "optional" in value && value.optional === true;

const parseAt = <S extends Schema<unknown>>(
  schemaValue: S,
  value: unknown,
  path: readonly SchemaPathSegment[],
): ParseResult<Infer<S>> => {
  const result = schemaValue.safeParse(value) as ParseResult<Infer<S>>;
  if (path.length === 0 || result.success) return result;
  return failure(
    ...result.issues.map((entry) =>
      issue(entry.code, [...path, ...entry.path], entry.message, entry.causes),
    ),
  );
};

const formatIssues = (issues: readonly SchemaIssue[]): string =>
  issues
    .map((entry) => {
      const path = entry.path.length === 0 ? "<root>" : entry.path.join(".");
      return `${path}: ${entry.message} [${entry.code}]`;
    })
    .join("; ");

/** Namespace-style convenience without custom syntax or registration. */
export const schema = Object.freeze({
  string,
  number,
  boolean,
  literal,
  array,
  object,
  optional,
  union,
  refine,
  id,
});
