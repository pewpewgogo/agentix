import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { RuntimeArm } from "./schedule.js";
import { fileManifest, hashJson, sha256, type FileManifestEntry } from "./evidence.js";

const execFileAsync = promisify(execFile);

export interface RuntimeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly nanoseconds: number;
}

export interface RuntimeCommandExecutor {
  readonly kind: "system" | "test-double";
  run(cwd: string, argv: readonly [string, ...string[]]): Promise<RuntimeCommandResult>;
}

const errorText = (cause: unknown, key: "stdout" | "stderr"): string =>
  typeof cause === "object" && cause !== null && key in cause &&
    typeof (cause as Record<string, unknown>)[key] === "string"
    ? (cause as Record<string, string>)[key]!
    : "";

export const systemCommandExecutor: RuntimeCommandExecutor = {
  kind: "system",
  async run(cwd, [executable, ...arguments_]) {
    const start = process.hrtime.bigint();
    try {
      const result = await execFileAsync(executable, arguments_, {
        cwd,
        env: {
          ...process.env,
          NO_COLOR: "1",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        nanoseconds: Number(process.hrtime.bigint() - start),
      };
    } catch (cause: unknown) {
      const exitCode = typeof cause === "object" && cause !== null &&
        "code" in cause && typeof cause.code === "number"
        ? cause.code
        : 1;
      return {
        exitCode,
        stdout: errorText(cause, "stdout"),
        stderr: errorText(cause, "stderr"),
        nanoseconds: Number(process.hrtime.bigint() - start),
      };
    }
  },
};

const excludedWorkspaceSegments = new Set([
  ".git",
  "node_modules",
  "dist",
  ".agentix",
  ".agentix-tmp",
  ".workspaces",
]);

const excludedInstalledDependencyEntries = new Set([
  ".cache",
  ".vite",
  ".vite-temp",
]);

export interface IsolatedRepository {
  readonly root: string;
  dispose(): Promise<void>;
}

export interface IsolatedRepositoryOptions {
  readonly includeInstalledDependencies?: boolean;
}

const isWithin = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." &&
    !path.startsWith(`..${sep}`));
};

const mirrorDependency = async (
  source: string,
  destination: string,
  repositoryRoot: string,
  isolatedRoot: string,
): Promise<void> => {
  const sourceStat = await lstat(source);
  if (!sourceStat.isSymbolicLink()) {
    await cp(source, destination, {
      recursive: sourceStat.isDirectory(),
      dereference: false,
      verbatimSymlinks: true,
    });
    return;
  }
  const resolvedSource = await realpath(source);
  const targetStat = await lstat(resolvedSource);
  if (isWithin(repositoryRoot, resolvedSource)) {
    const target = resolve(isolatedRoot, relative(repositoryRoot, resolvedSource));
    await symlink(target, destination, targetStat.isDirectory() ? "dir" : "file");
    return;
  }
  await cp(resolvedSource, destination, {
    recursive: targetStat.isDirectory(),
    dereference: false,
    verbatimSymlinks: true,
  });
};

const removeWritePermissions = async (path: string): Promise<void> => {
  const status = await lstat(path);
  if (status.isSymbolicLink()) return;
  if (status.isDirectory()) {
    const children = await readdir(path, { withFileTypes: true });
    for (const child of children) {
      await removeWritePermissions(resolve(path, child.name));
    }
  }
  await chmod(path, status.mode & ~0o222);
};

const restoreOwnerWritePermissions = async (path: string): Promise<void> => {
  const status = await lstat(path);
  if (status.isSymbolicLink()) return;
  await chmod(path, status.mode | 0o200);
  if (status.isDirectory()) {
    const children = await readdir(path, { withFileTypes: true });
    for (const child of children) {
      await restoreOwnerWritePermissions(resolve(path, child.name));
    }
  }
};

const assertContainedDependencyLinks = async (
  path: string,
  isolatedRoot: string,
): Promise<void> => {
  const status = await lstat(path);
  if (status.isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path));
    if (!isWithin(isolatedRoot, target)) {
      throw new Error(`Copied dependency symlink escapes the isolated repository: ${path}`);
    }
    return;
  }
  if (!status.isDirectory()) return;
  const children = await readdir(path, { withFileTypes: true });
  for (const child of children) {
    await assertContainedDependencyLinks(resolve(path, child.name), isolatedRoot);
  }
};

const disposeScratch = async (scratch: string): Promise<void> => {
  const dependencies = resolve(scratch, "repository/node_modules");
  try {
    await restoreOwnerWritePermissions(dependencies);
  } catch (cause: unknown) {
    if (!(typeof cause === "object" && cause !== null && "code" in cause &&
      cause.code === "ENOENT")) {
      throw cause;
    }
  }
  await rm(scratch, { recursive: true, force: true });
};

const mirrorInstalledDependencies = async (
  repositoryRoot: string,
  isolatedRoot: string,
): Promise<void> => {
  const dependencies = resolve(repositoryRoot, "node_modules");
  if (!(await lstat(dependencies)).isDirectory()) {
    throw new Error("Runtime benchmark requires an installed node_modules directory.");
  }
  const isolatedDependencies = resolve(isolatedRoot, "node_modules");
  await mkdir(isolatedDependencies);
  const entries = await readdir(dependencies, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (excludedInstalledDependencyEntries.has(entry.name)) continue;
    const source = resolve(dependencies, entry.name);
    const destination = resolve(isolatedDependencies, entry.name);
    if (!entry.isDirectory() || !entry.name.startsWith("@")) {
      await mirrorDependency(source, destination, repositoryRoot, isolatedRoot);
      await removeWritePermissions(destination);
      continue;
    }
    // Scoped package directories may mix external packages with repository-owned
    // npm workspace links. Mirror one level so local links can be retargeted.
    await mkdir(destination);
    const scoped = await readdir(source, { withFileTypes: true });
    for (const child of scoped.sort((left, right) => left.name.localeCompare(right.name))) {
      const childDestination = resolve(destination, child.name);
      await mirrorDependency(
        resolve(source, child.name),
        childDestination,
        repositoryRoot,
        isolatedRoot,
      );
      if (!(await lstat(childDestination)).isSymbolicLink()) {
        await removeWritePermissions(childDestination);
      }
    }
    await removeWritePermissions(destination);
  }
  await assertContainedDependencyLinks(isolatedDependencies, isolatedRoot);
  await removeWritePermissions(isolatedDependencies);
};

export const createIsolatedRepository = async (
  repositoryRootInput: string,
  options: IsolatedRepositoryOptions = {},
): Promise<IsolatedRepository> => {
  // Canonicalize first so macOS /var -> /private/var aliases cannot make a
  // repository-owned workspace symlink look external to the containment test.
  const repositoryRoot = await realpath(resolve(repositoryRootInput));
  const scratch = await mkdtemp(resolve(tmpdir(), "agentix-runtime-workspace-"));
  const isolatedRoot = resolve(scratch, "repository");
  try {
    await cp(repositoryRoot, isolatedRoot, {
      recursive: true,
      filter: (source) => {
        const path = source.slice(repositoryRoot.length).replace(/^\/+/, "");
        if (path === "") return true;
        const segments = path.split("/");
        if (segments.some((segment) => excludedWorkspaceSegments.has(segment))) {
          return false;
        }
        return !(segments[0] === "benchmarks" && segments[1] === "results");
      },
    });
    if (options.includeInstalledDependencies !== false) {
      await mirrorInstalledDependencies(repositoryRoot, isolatedRoot);
    }
    return {
      root: isolatedRoot,
      async dispose() {
        await disposeScratch(scratch);
      },
    };
  } catch (cause: unknown) {
    await disposeScratch(scratch);
    throw cause;
  }
};

const appWorkspace = (arm: RuntimeArm): string =>
  arm === "framework" ? "@agentixdev/framework-app" : "@agentixdev/plain-app";

const appDirectory = (arm: RuntimeArm): string =>
  arm === "framework" ? "examples/framework-app" : "examples/plain-app";

export interface BuiltArmEvidence {
  readonly implementation: RuntimeArm;
  readonly buildCommand: readonly string[];
  readonly entryRelativePath: string;
  readonly entrySha256: string;
  readonly outputManifestSha256: string;
  readonly workspaceOutputManifestSha256: string;
  readonly sourceManifestSha256: string;
}

const workspaceOutputManifest = async (
  isolatedRoot: string,
): Promise<string> => {
  const entries: FileManifestEntry[] = [];
  for (const parent of ["packages", "examples"] as const) {
    const parentPath = resolve(isolatedRoot, parent);
    for (const workspace of await readdir(parentPath, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const output = resolve(parentPath, workspace.name, "dist");
      try {
        if (!(await lstat(output)).isDirectory()) continue;
      } catch {
        continue;
      }
      const manifest = await fileManifest(output);
      for (const entry of manifest.entries) {
        entries.push({
          ...entry,
          path: `${parent}/${workspace.name}/dist/${entry.path}`,
        });
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return hashJson(entries);
};

export type PreparedArmBuild =
  | {
      readonly ok: true;
      readonly implementation: RuntimeArm;
      readonly isolatedRoot: string;
      readonly entryPath: string;
      readonly evidence: BuiltArmEvidence;
      dispose(): Promise<void>;
    }
  | {
      readonly ok: false;
      readonly implementation: RuntimeArm;
      readonly exitCode: number;
      readonly reason: string;
    };

export const prepareBuiltArm = async (input: {
  readonly repositoryRoot: string;
  readonly arm: RuntimeArm;
  readonly executor?: RuntimeCommandExecutor;
  readonly includeInstalledDependencies?: boolean;
}): Promise<PreparedArmBuild> => {
  const executor = input.executor ?? systemCommandExecutor;
  const isolated = await createIsolatedRepository(
    input.repositoryRoot,
    input.includeInstalledDependencies === undefined
      ? {}
      : { includeInstalledDependencies: input.includeInstalledDependencies },
  );
  const command = Object.freeze([
    "npm",
    "run",
    "build",
    "--workspace",
    appWorkspace(input.arm),
  ] as const);
  let result: RuntimeCommandResult;
  try {
    result = await executor.run(isolated.root, command);
  } catch (cause: unknown) {
    await isolated.dispose();
    return {
      ok: false,
      implementation: input.arm,
      exitCode: 1,
      reason: `Fresh ${input.arm} build executor failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (result.exitCode !== 0) {
    await isolated.dispose();
    const details = [result.stderr.trim(), result.stdout.trim()]
      .filter((value) => value.length > 0)
      .join("\n")
      .slice(0, 2_000);
    return {
      ok: false,
      implementation: input.arm,
      exitCode: result.exitCode,
      reason: details.length === 0
        ? `Fresh ${input.arm} build exited ${result.exitCode}.`
        : `Fresh ${input.arm} build exited ${result.exitCode}: ${details}`,
    };
  }

  const directory = appDirectory(input.arm);
  const entryRelativePath = `${directory}/dist/index.js`;
  const entryPath = resolve(isolated.root, entryRelativePath);
  const outputDirectory = resolve(isolated.root, directory, "dist");
  const sourceDirectory = resolve(isolated.root, directory, "src");
  try {
    const [entry, output, workspaceOutput, source] = await Promise.all([
      readFile(entryPath),
      fileManifest(outputDirectory),
      workspaceOutputManifest(isolated.root),
      fileManifest(sourceDirectory),
    ]);
    return {
      ok: true,
      implementation: input.arm,
      isolatedRoot: isolated.root,
      entryPath,
      evidence: Object.freeze({
        implementation: input.arm,
        buildCommand: command,
        entryRelativePath,
        entrySha256: sha256(entry),
        outputManifestSha256: output.sha256,
        workspaceOutputManifestSha256: workspaceOutput,
        sourceManifestSha256: source.sha256,
      }),
      dispose: isolated.dispose,
    };
  } catch (cause: unknown) {
    await isolated.dispose();
    return {
      ok: false,
      implementation: input.arm,
      exitCode: 1,
      reason: `Fresh ${input.arm} build produced no valid bound output: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
};

export type NormalizedMaxRss =
  | { readonly available: true; readonly bytes: number }
  | { readonly available: false; readonly reason: string };

/** Node reports process.resourceUsage().maxRSS in KiB. */
export const normalizeNodeMaxRss = (value: unknown): NormalizedMaxRss => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return {
      available: false,
      reason: "process.resourceUsage().maxRSS was unavailable or non-positive.",
    };
  }
  const bytes = value * 1_024;
  if (!Number.isSafeInteger(bytes)) {
    return {
      available: false,
      reason: "process.resourceUsage().maxRSS could not be represented safely in bytes.",
    };
  }
  return { available: true, bytes };
};

interface ProbePayload {
  readonly retainedRssBytes?: unknown;
  readonly maxRssKiB?: unknown;
  readonly maxRssReason?: unknown;
}

const parseProbePayload = (stdout: string): ProbePayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause: unknown) {
    throw new SyntaxError("Runtime process probe returned malformed JSON.", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Runtime process probe returned a non-object payload.");
  }
  return parsed as ProbePayload;
};

export interface ColdStartProbe {
  readonly nanoseconds: number;
  readonly exitCode: number;
  readonly reason: string | null;
}

export const coldStartProbe = async (
  build: Extract<PreparedArmBuild, { readonly ok: true }>,
  executor: RuntimeCommandExecutor,
): Promise<ColdStartProbe> => {
  const script = "await import(process.argv[1]);";
  const result = await executor.run(build.isolatedRoot, [
    process.execPath,
    "--input-type=module",
    "--eval",
    script,
    build.entryPath,
  ]);
  return {
    nanoseconds: result.nanoseconds,
    exitCode: result.exitCode,
    reason: result.exitCode === 0
      ? null
      : `Cold-start child exited ${result.exitCode}: ${result.stderr.trim()}`,
  };
};

export interface MemoryProbe {
  readonly exitCode: number;
  readonly retainedRssBytes: number | null;
  readonly maxRss: NormalizedMaxRss;
  readonly reason: string | null;
}

export const memoryProbe = async (
  build: Extract<PreparedArmBuild, { readonly ok: true }>,
  executor: RuntimeCommandExecutor,
): Promise<MemoryProbe> => {
  const factoryName = build.implementation === "framework"
    ? "createFrameworkSystem"
    : "createPlainSystem";
  const script = [
    "const mod = await import(process.argv[1]);",
    "globalThis.gc();",
    "const before = process.memoryUsage().rss;",
    `const systems = Array.from({ length: 100 }, () => mod.${factoryName}());`,
    "globalThis.gc();",
    "const retainedRssBytes = process.memoryUsage().rss - before;",
    "const usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : undefined;",
    "const maxRssKiB = usage?.maxRSS;",
    "const maxRssReason = typeof maxRssKiB === 'number' ? undefined : 'process.resourceUsage is unsupported';",
    "process.stdout.write(JSON.stringify({ retainedRssBytes, maxRssKiB, maxRssReason, retained: systems.length }));",
  ].join("\n");
  const result = await executor.run(build.isolatedRoot, [
    process.execPath,
    "--expose-gc",
    "--input-type=module",
    "--eval",
    script,
    build.entryPath,
  ]);
  if (result.exitCode !== 0) {
    return {
      exitCode: result.exitCode,
      retainedRssBytes: null,
      maxRss: { available: false, reason: "Memory child process failed." },
      reason: `Memory child exited ${result.exitCode}: ${result.stderr.trim()}`,
    };
  }
  try {
    const payload = parseProbePayload(result.stdout);
    const retained = payload.retainedRssBytes;
    if (typeof retained !== "number" || !Number.isSafeInteger(retained)) {
      throw new TypeError("Memory probe returned no safe-integer retained RSS delta.");
    }
    const maxRss = normalizeNodeMaxRss(payload.maxRssKiB);
    return {
      exitCode: 0,
      retainedRssBytes: retained,
      maxRss: maxRss.available
        ? maxRss
        : {
            available: false,
            reason: typeof payload.maxRssReason === "string"
              ? payload.maxRssReason
              : maxRss.reason,
          },
      reason: null,
    };
  } catch (cause: unknown) {
    return {
      exitCode: 1,
      retainedRssBytes: null,
      maxRss: { available: false, reason: "Memory probe payload was invalid." },
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

export type ToolchainMetric =
  | "clean-build"
  | "full-typecheck"
  | "incremental-verification";

export type ToolchainMeasurement =
  | { readonly ok: true; readonly nanoseconds: number }
  | {
      readonly ok: false;
      readonly exitCode: number;
      readonly stage: "prerequisite" | "measurement";
      readonly reason: string;
    };

const toolchainCommand = (
  metric: Exclude<ToolchainMetric, "incremental-verification">,
  arm: RuntimeArm,
): readonly [string, ...string[]] => metric === "clean-build"
  ? ["npm", "run", "build", "--workspace", appWorkspace(arm)]
  : ["npm", "run", "typecheck", "--workspace", appWorkspace(arm)];

const failedCommandReason = (
  label: string,
  result: RuntimeCommandResult,
): string => {
  const details = [result.stderr.trim(), result.stdout.trim()]
    .filter((value) => value.length > 0)
    .join("\n")
    .slice(0, 2_000);
  return details.length === 0
    ? `${label} exited ${result.exitCode}.`
    : `${label} exited ${result.exitCode}: ${details}`;
};

export const measureToolchain = async (input: {
  readonly repositoryRoot: string;
  readonly metric: ToolchainMetric;
  readonly arm: RuntimeArm;
  readonly executor?: RuntimeCommandExecutor;
}): Promise<ToolchainMeasurement> => {
  const executor = input.executor ?? systemCommandExecutor;
  const isolated = await createIsolatedRepository(input.repositoryRoot);
  try {
    if (input.metric !== "incremental-verification") {
      if (input.metric === "full-typecheck" && input.arm === "framework") {
        // architecture.test.ts imports the compiler as installed tooling, but
        // its test tsconfig does not project-reference it. Since all copied
        // dist is intentionally absent, bootstrap that local workspace package
        // outside the measured app typecheck instead of resolving root dist.
        const prerequisite = await executor.run(isolated.root, [
          "npm", "run", "build", "--workspace", "@agentixdev/compiler",
        ]);
        if (prerequisite.exitCode !== 0) {
          return {
            ok: false,
            exitCode: prerequisite.exitCode,
            stage: "prerequisite",
            reason: failedCommandReason(
              "Framework full-typecheck compiler prerequisite",
              prerequisite,
            ),
          };
        }
      }
      const result = await executor.run(
        isolated.root,
        toolchainCommand(input.metric, input.arm),
      );
      return result.exitCode === 0
        ? { ok: true, nanoseconds: result.nanoseconds }
        : {
            ok: false,
            exitCode: result.exitCode,
            stage: "measurement",
            reason: failedCommandReason(`${input.arm} ${input.metric}`, result),
          };
    }

    const prerequisiteCommands: readonly (readonly [string, ...string[]])[] =
      input.arm === "framework"
        ? [
            ["npm", "run", "build", "--workspace", "@agentixdev/cli"],
            ["npm", "run", "build", "--workspace", "@agentixdev/framework-app"],
          ]
        : [["npm", "run", "build", "--workspace", "@agentixdev/plain-app"]];
    for (const command of prerequisiteCommands) {
      const build = await executor.run(isolated.root, command);
      if (build.exitCode !== 0) {
        return {
          ok: false,
          exitCode: build.exitCode,
          stage: "prerequisite",
          reason: failedCommandReason(`${input.arm} incremental prerequisite build`, build),
        };
      }
    }
    const source = input.arm === "framework"
      ? resolve(isolated.root, "examples/framework-app/src/features/customers/operations.ts")
      : resolve(isolated.root, "examples/plain-app/src/features/customers/customer.ts");
    const original = await readFile(source, "utf8");
    const [needle, replacement] = input.arm === "framework"
      ? [
          'message: "Customer name must not be blank",',
          'message: "Customer name is required",',
        ]
      : [
          "name: z.string().trim().min(1),",
          'name: z.string().trim().min(1, "Customer name is required"),',
        ];
    if (!original.includes(needle)) {
      return {
        ok: false,
        exitCode: 1,
        stage: "prerequisite",
        reason: `Frozen ${input.arm} semantic incremental edit target is stale.`,
      };
    }
    await writeFile(source, original.replace(needle, replacement), "utf8");

    if (input.arm === "framework") {
      const result = await executor.run(isolated.root, [
        process.execPath,
        "packages/cli/dist/bin.js",
        "verify",
        "customers.create",
        "--root",
        "examples/framework-app",
        "--json",
      ]);
      return result.exitCode === 0
        ? { ok: true, nanoseconds: result.nanoseconds }
        : {
            ok: false,
            exitCode: result.exitCode,
            stage: "measurement",
            reason: failedCommandReason("Framework incremental verification", result),
          };
    }
    const typecheck = await executor.run(isolated.root, [
      "npm", "run", "typecheck", "--workspace", "@agentixdev/plain-app",
    ]);
    if (typecheck.exitCode !== 0) {
      return {
        ok: false,
        exitCode: typecheck.exitCode,
        stage: "measurement",
        reason: failedCommandReason("Plain incremental typecheck", typecheck),
      };
    }
    const tests = await executor.run(isolated.root, [
      "npm", "test", "--workspace", "@agentixdev/plain-app",
    ]);
    return tests.exitCode === 0
      ? { ok: true, nanoseconds: typecheck.nanoseconds + tests.nanoseconds }
      : {
          ok: false,
          exitCode: tests.exitCode,
          stage: "measurement",
          reason: failedCommandReason("Plain incremental tests", tests),
        };
  } finally {
    await isolated.dispose();
  }
};
