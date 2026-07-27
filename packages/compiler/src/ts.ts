/**
 * Sole access point for TypeScript's unstable native-compiler API.
 *
 * `typescript/unstable/sync` ships with no stability guarantees: any TypeScript
 * release may move, rename, or reshape these entry points. `@agentix/compiler`
 * therefore pins an exact `typescript` dependency (see package.json) and this
 * module verifies at load time that the entry point and every symbol the
 * compiler relies on are present, so a mismatched TypeScript install fails with
 * one actionable error instead of an obscure crash inside the scanner.
 */

export type { Checker, Symbol as TypeScriptSymbol } from "typescript/unstable/sync";

/** The exact TypeScript release this build of @agentix/compiler supports. */
export const PINNED_TYPESCRIPT_VERSION = "7.0.2";

type ExpectedKind = "function" | "number" | "object";

const describeFailure = (specifier: string, detail: string): string =>
  `@agentix/compiler could not load the unstable TypeScript compiler API "${specifier}": ${detail} ` +
  `This @agentix/compiler build supports exactly typescript@${PINNED_TYPESCRIPT_VERSION}. ` +
  `Install that release (npm install --save-exact typescript@${PINNED_TYPESCRIPT_VERSION}) ` +
  `or upgrade @agentix/compiler to a release built for your TypeScript version.`;

const symbolAt = (moduleExports: object, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)[key]
          : undefined,
      moduleExports,
    );

/**
 * Throws when any required export (dotted paths allowed) is missing from the
 * unstable module or no longer has the expected runtime shape.
 */
export const assertUnstableApiShape = (
  specifier: string,
  moduleExports: object,
  expected: Readonly<Record<string, ExpectedKind>>,
): void => {
  const problems = Object.entries(expected)
    .filter(([path, kind]) => typeof symbolAt(moduleExports, path) !== kind)
    .map(([path]) => path);
  if (problems.length > 0) {
    throw new Error(
      describeFailure(specifier, `missing or renamed symbols: ${problems.join(", ")}.`),
    );
  }
};

export const UNSTABLE_SYNC_API_SHAPE = {
  API: "function",
  SymbolFlags: "object",
  "SymbolFlags.Alias": "number",
} as const satisfies Readonly<Record<string, ExpectedKind>>;

type UnstableSyncApi = typeof import("typescript/unstable/sync");

const loadUnstableSyncApi = async (): Promise<UnstableSyncApi> => {
  let loaded: UnstableSyncApi;
  try {
    loaded = await import("typescript/unstable/sync");
  } catch (cause) {
    throw new Error(
      describeFailure(
        "typescript/unstable/sync",
        "the installed TypeScript release does not provide this entry point.",
      ),
      { cause },
    );
  }
  assertUnstableApiShape("typescript/unstable/sync", loaded, UNSTABLE_SYNC_API_SHAPE);
  return loaded;
};

const unstableSyncApi = await loadUnstableSyncApi();

export const { API, SymbolFlags } = unstableSyncApi;
