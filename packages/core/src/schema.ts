export type SchemaPathSegment = string | number;

export type SchemaIssueCode =
  | "invalid_type"
  | "invalid_string"
  | "invalid_number"
  | "invalid_literal"
  | "required"
  | "unexpected_key"
  | "invalid_union"
  | "refinement_failed"
  | "invalid_id"
  | "too_many_issues";

export interface SchemaIssue {
  readonly code: SchemaIssueCode;
  readonly path: readonly SchemaPathSegment[];
  readonly message: string;
  readonly causes?: readonly SchemaIssue[];
}

export type LiteralValue = string | number | boolean | null;

export type SchemaDescription =
  | {
      readonly type: "string";
      readonly min?: number;
      readonly max?: number;
      readonly trim?: boolean;
      readonly pattern?: string;
    }
  | {
      readonly type: "number";
      readonly min?: number;
      readonly max?: number;
      readonly int?: boolean;
    }
  | { readonly type: "boolean" }
  | { readonly type: "literal"; readonly value: LiteralValue }
  | { readonly type: "array"; readonly item: SchemaDescription }
  | {
      readonly type: "object";
      readonly fields: Readonly<Record<string, SchemaDescription>>;
    }
  | { readonly type: "record"; readonly value: SchemaDescription }
  | { readonly type: "tuple"; readonly items: readonly SchemaDescription[] }
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

export type SchemaShape = Readonly<Record<string, Schema<unknown>>>;

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

type Parser<T> = (value: unknown) => ParseResult<T>;

const success = <T>(data: T): ParseSuccess<T> => ({ success: true, data });

const failure = (...issues: readonly SchemaIssue[]): ParseFailure => ({
  success: false,
  issues,
});

/** Issues start with a root-relative path; parents prefix keys on failure only. */
const issue = (
  code: SchemaIssueCode,
  message: string,
  segment?: SchemaPathSegment,
  causes?: readonly SchemaIssue[],
): SchemaIssue => {
  const path: readonly SchemaPathSegment[] = segment === undefined ? [] : [segment];
  return causes === undefined
    ? { code, path, message }
    : { code, path, message, causes };
};

/** Lazy path construction: only failing branches pay for path arrays. */
const prefixIssue = (
  segment: SchemaPathSegment,
  entry: SchemaIssue,
): SchemaIssue =>
  entry.causes === undefined
    ? { code: entry.code, path: [segment, ...entry.path], message: entry.message }
    : {
        code: entry.code,
        path: [segment, ...entry.path],
        message: entry.message,
        causes: entry.causes,
      };

/** Per-parse cap on accumulated issues; one truncation marker follows it. */
const MAX_ISSUES = 100;

/**
 * Bounded append: pushes `entry` unless the list already holds MAX_ISSUES
 * issues, in which case a single `too_many_issues` marker is appended
 * instead. Returns false once the list is full so callers stop collecting.
 * Never uses push(...spread): huge nested failure lists must not blow the
 * argument stack.
 */
const pushIssueCapped = (issues: SchemaIssue[], entry: SchemaIssue): boolean => {
  if (issues.length > MAX_ISSUES) return false;
  if (issues.length === MAX_ISSUES) {
    issues.push(
      issue(
        "too_many_issues",
        `Too many issues; validation stopped after ${MAX_ISSUES}`,
      ),
    );
    return false;
  }
  issues.push(entry);
  return true;
};

/** Bounded, loop-based variant of the old prefixIssues spread-push. */
const pushPrefixedIssuesCapped = (
  issues: SchemaIssue[],
  segment: SchemaPathSegment,
  child: readonly SchemaIssue[],
): boolean => {
  for (const entry of child) {
    if (!pushIssueCapped(issues, prefixIssue(segment, entry))) return false;
  }
  return true;
};

const createSchema = <T>(
  description: SchemaDescription,
  parser: Parser<T>,
): Schema<T> =>
  Object.freeze({
    description,
    safeParse: parser,
    parse(value: unknown): T {
      const result = parser(value);
      if (result.success) return result.data;
      throw new SchemaValidationError(result.issues);
    },
  });

const describeValue = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isNaN(value)) return "NaN";
  return typeof value;
};

const assertLengthBound = (value: number | undefined, label: string): void => {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
};

const assertNumericBound = (value: number | undefined, label: string): void => {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
};

export interface StringOptions {
  readonly min?: number;
  readonly max?: number;
  /** The only transform: runs before length/pattern validation. */
  readonly trim?: boolean;
  readonly pattern?: RegExp;
}

export const string = (options: StringOptions = {}): Schema<string> => {
  const { min, max } = options;
  const trim = options.trim === true;
  assertLengthBound(min, "string min");
  assertLengthBound(max, "string max");
  if (min !== undefined && max !== undefined && min > max) {
    throw new TypeError("string min must not exceed max");
  }
  // Copy without sticky/global flags so shared schemas never carry lastIndex state.
  const pattern =
    options.pattern === undefined
      ? undefined
      : new RegExp(options.pattern.source, options.pattern.flags.replace(/[gy]/gu, ""));

  const description: SchemaDescription = Object.freeze({
    type: "string",
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(trim ? { trim } : {}),
    ...(pattern === undefined ? {} : { pattern: pattern.source }),
  });

  return createSchema(description, (value) => {
    if (typeof value !== "string") {
      return failure(
        issue("invalid_type", `Expected string, received ${describeValue(value)}`),
      );
    }
    const text = trim ? value.trim() : value;
    if (min !== undefined && text.length < min) {
      return failure(
        issue("invalid_string", `Expected at least ${min} character(s)`),
      );
    }
    if (max !== undefined && text.length > max) {
      return failure(
        issue("invalid_string", `Expected at most ${max} character(s)`),
      );
    }
    if (pattern !== undefined && !pattern.test(text)) {
      return failure(
        issue("invalid_string", `Expected string matching /${pattern.source}/`),
      );
    }
    return success(text);
  });
};

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly int?: boolean;
}

export const number = (options: NumberOptions = {}): Schema<number> => {
  const { min, max } = options;
  const int = options.int === true;
  assertNumericBound(min, "number min");
  assertNumericBound(max, "number max");
  if (min !== undefined && max !== undefined && min > max) {
    throw new TypeError("number min must not exceed max");
  }

  const description: SchemaDescription = Object.freeze({
    type: "number",
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(int ? { int } : {}),
  });

  return createSchema(description, (value) => {
    if (typeof value !== "number") {
      return failure(
        issue("invalid_type", `Expected number, received ${describeValue(value)}`),
      );
    }
    if (!Number.isFinite(value)) {
      return failure(issue("invalid_number", "Expected a finite number"));
    }
    if (int && !Number.isInteger(value)) {
      return failure(issue("invalid_number", "Expected an integer"));
    }
    if (min !== undefined && value < min) {
      return failure(issue("invalid_number", `Expected a number >= ${min}`));
    }
    if (max !== undefined && value > max) {
      return failure(issue("invalid_number", `Expected a number <= ${max}`));
    }
    return success(value);
  });
};

export const boolean = (): Schema<boolean> =>
  createSchema(Object.freeze({ type: "boolean" }), (value) =>
    typeof value === "boolean"
      ? success(value)
      : failure(
          issue("invalid_type", `Expected boolean, received ${describeValue(value)}`),
        ),
  );

export const literal = <const T extends LiteralValue>(value: T): Schema<T> =>
  createSchema(Object.freeze({ type: "literal", value }), (input) =>
    Object.is(input, value)
      ? success(value)
      : failure(issue("invalid_literal", `Expected literal ${JSON.stringify(value)}`)),
  );

export const array = <S extends Schema<unknown>>(
  item: S,
): Schema<readonly Infer<S>[]> =>
  createSchema<readonly Infer<S>[]>(
    Object.freeze({ type: "array", item: item.description }),
    (value) => {
      if (!Array.isArray(value)) {
        return failure(
          issue("invalid_type", `Expected array, received ${describeValue(value)}`),
        );
      }

      const parsed: Infer<S>[] = [];
      let issues: SchemaIssue[] | undefined;
      for (let index = 0; index < value.length; index += 1) {
        const result = item.safeParse(value[index]);
        if (result.success) parsed.push(result.data as Infer<S>);
        else if (!pushPrefixedIssuesCapped((issues ??= []), index, result.issues)) {
          break; // capped: the parse already failed, stop collecting
        }
      }
      return issues === undefined ? success(parsed) : { success: false, issues };
    },
  );

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

export interface ObjectSchema<S extends SchemaShape>
  extends Schema<ObjectOutput<S>> {
  readonly shape: S;
}

interface ObjectField {
  readonly key: string;
  readonly schema: Schema<unknown>;
  readonly optional: boolean;
}

/** Strict object schema: unknown keys are rejected. */
export const object = <const S extends SchemaShape>(shape: S): ObjectSchema<S> => {
  const shapeSnapshot = Object.freeze({ ...shape }) as S;
  // Keys sorted ONCE at creation; parse never re-sorts.
  const keys = Object.keys(shapeSnapshot).sort();
  const known = new Set(keys);
  const fields: ObjectField[] = [];
  const descriptionFields: Record<string, SchemaDescription> = {};
  for (const key of keys) {
    const field = shapeSnapshot[key];
    if (field === undefined) continue;
    fields.push({ key, schema: field, optional: isOptionalSchema(field) });
    descriptionFields[key] = field.description;
  }

  const parser: Parser<ObjectOutput<S>> = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return failure(
        issue("invalid_type", `Expected object, received ${describeValue(value)}`),
      );
    }

    const source = value as Record<string, unknown>;
    const parsed: Record<string, unknown> = {};
    let issues: SchemaIssue[] | undefined;

    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(source, field.key)) {
        if (
          !field.optional &&
          !pushIssueCapped(
            (issues ??= []),
            issue("required", "Required field is missing", field.key),
          )
        ) {
          break; // capped: the parse already failed, stop collecting
        }
        continue;
      }
      const result = field.schema.safeParse(source[field.key]);
      if (result.success) parsed[field.key] = result.data;
      else if (!pushPrefixedIssuesCapped((issues ??= []), field.key, result.issues)) {
        break; // capped
      }
    }

    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key) && !known.has(key)) {
        if (
          !pushIssueCapped(
            (issues ??= []),
            issue("unexpected_key", `Unexpected key ${JSON.stringify(key)}`, key),
          )
        ) {
          break; // capped
        }
      }
    }

    return issues === undefined
      ? success(parsed as ObjectOutput<S>)
      : { success: false, issues };
  };

  return Object.freeze({
    description: Object.freeze({
      type: "object",
      fields: Object.freeze(descriptionFields),
    }) as SchemaDescription,
    shape: shapeSnapshot,
    safeParse: parser,
    parse(value: unknown): ObjectOutput<S> {
      const result = parser(value);
      if (result.success) return result.data;
      throw new SchemaValidationError(result.issues);
    },
  });
};

export const optional = <S extends Schema<unknown>>(
  inner: S,
): OptionalSchema<Infer<S>> =>
  Object.freeze({
    description: Object.freeze({ type: "optional", inner: inner.description }) as SchemaDescription,
    optional: true,
    inner: inner as Schema<Infer<S>>,
    safeParse(value: unknown): ParseResult<Infer<S> | undefined> {
      return value === undefined
        ? success(undefined)
        : (inner.safeParse(value) as ParseResult<Infer<S>>);
    },
    parse(value: unknown): Infer<S> | undefined {
      if (value === undefined) return undefined;
      return inner.parse(value) as Infer<S>;
    },
  });

/**
 * Open string-keyed map: every own enumerable string key is kept and its
 * value is validated against `value`. There is no unknown-key policy —
 * arbitrary keys are the point (values are what gets validated).
 */
export const record = <S extends Schema<unknown>>(
  value: S,
): Schema<Record<string, Infer<S>>> =>
  createSchema<Record<string, Infer<S>>>(
    Object.freeze({ type: "record", value: value.description }),
    (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return failure(
          issue("invalid_type", `Expected object, received ${describeValue(input)}`),
        );
      }
      const source = input as Record<string, unknown>;
      const parsed: Record<string, unknown> = {};
      let issues: SchemaIssue[] | undefined;
      for (const key of Object.keys(source)) {
        const result = value.safeParse(source[key]);
        if (result.success) {
          // defineProperty: keys are caller-controlled, so "__proto__" must
          // become an own data property, never a prototype mutation.
          Object.defineProperty(parsed, key, {
            configurable: true,
            enumerable: true,
            value: result.data,
            writable: true,
          });
        } else if (!pushPrefixedIssuesCapped((issues ??= []), key, result.issues)) {
          break; // capped: the parse already failed, stop collecting
        }
      }
      return issues === undefined
        ? success(parsed as Record<string, Infer<S>>)
        : { success: false, issues };
    },
  );

export type TupleOutput<S extends readonly Schema<unknown>[]> = {
  [K in keyof S]: S[K] extends Schema<infer T> ? T : never;
};

/** Fixed-length tuple: the value must be an array of exactly `items.length`. */
export const tuple = <const S extends readonly [Schema<unknown>, ...Schema<unknown>[]]>(
  items: S,
): Schema<TupleOutput<S>> => {
  const itemsSnapshot = Object.freeze([...items]) as unknown as S;
  if (itemsSnapshot.length === 0) {
    throw new TypeError("tuple requires at least one element schema");
  }
  return createSchema<TupleOutput<S>>(
    Object.freeze({
      type: "tuple",
      items: Object.freeze(itemsSnapshot.map((item) => item.description)),
    }),
    (value) => {
      if (!Array.isArray(value)) {
        return failure(
          issue("invalid_type", `Expected array, received ${describeValue(value)}`),
        );
      }
      if (value.length !== itemsSnapshot.length) {
        return failure(
          issue(
            "invalid_type",
            `Expected a tuple of ${itemsSnapshot.length} element(s), received ${value.length}`,
          ),
        );
      }
      const parsed = new Array<unknown>(itemsSnapshot.length);
      let issues: SchemaIssue[] | undefined;
      for (let index = 0; index < itemsSnapshot.length; index += 1) {
        const item = itemsSnapshot[index];
        if (item === undefined) continue; // noUncheckedIndexedAccess; unreachable
        const result = item.safeParse(value[index]);
        if (result.success) parsed[index] = result.data;
        else if (!pushPrefixedIssuesCapped((issues ??= []), index, result.issues)) {
          break; // capped
        }
      }
      return issues === undefined
        ? success(parsed as unknown as TupleOutput<S>)
        : { success: false, issues };
    },
  );
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
    (value) => {
      let causes: SchemaIssue[] | undefined;
      for (const option of optionsSnapshot) {
        const result = option.safeParse(value);
        if (result.success) return result as ParseSuccess<Infer<S[number]>>;
        // Cap the causes but NEVER stop trying options: a later option can
        // still succeed after an earlier one failed with a huge issue list.
        causes ??= [];
        for (const entry of result.issues) {
          if (!pushIssueCapped(causes, entry)) break;
        }
      }
      return failure(
        issue("invalid_union", "Value did not match any union option", undefined, causes),
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
    (value) => {
      const parsed = base.safeParse(value) as ParseResult<Infer<S>>;
      if (!parsed.success) return parsed;
      try {
        return predicate(parsed.data)
          ? parsed
          : failure(issue("refinement_failed", normalized.message));
      } catch {
        return failure(issue("refinement_failed", normalized.message));
      }
    },
  );
};

export const id = <const Brand extends string>(
  brand: Brand,
): Schema<BrandedId<Brand>> => {
  if (brand.length === 0) throw new TypeError("ID brand must not be empty");
  return createSchema(Object.freeze({ type: "id", brand }), (value) =>
    typeof value === "string" && value.length > 0
      ? success(value as BrandedId<Brand>)
      : failure(issue("invalid_id", `Expected a non-empty ${brand} id`)),
  );
};

const isOptionalSchema = (value: Schema<unknown>): value is OptionalSchema<unknown> =>
  "optional" in value && (value as { optional?: unknown }).optional === true;

const formatIssues = (issues: readonly SchemaIssue[]): string =>
  issues
    .map((entry) => {
      const path = entry.path.length === 0 ? "<root>" : entry.path.join(".");
      return `${path}: ${entry.message} [${entry.code}]`;
    })
    .join("; ");
