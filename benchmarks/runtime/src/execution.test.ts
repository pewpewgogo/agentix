import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "./evidence.js";
import {
  coldStartProbe,
  createIsolatedRepository,
  measureToolchain,
  memoryProbe,
  normalizeNodeMaxRss,
  prepareBuiltArm,
  systemCommandExecutor,
  type PreparedArmBuild,
  type RuntimeCommandExecutor,
} from "./execution.js";

const temporaryDirectories: string[] = [];

const temporaryRepository = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "agentix-runtime-test-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(resolve(root, "node_modules"), { recursive: true }),
    mkdir(resolve(root, "packages"), { recursive: true }),
    mkdir(resolve(root, "examples/framework-app/src/features/customers"), { recursive: true }),
    mkdir(resolve(root, "examples/plain-app/src/features/customers"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, "package.json"), JSON.stringify({
      private: true,
      workspaces: ["packages/*", "examples/*"],
    })),
    writeFile(
      resolve(root, "examples/framework-app/src/features/customers/operations.ts"),
      'export const message = { message: "Customer name must not be blank", };\n',
    ),
    writeFile(
      resolve(root, "examples/plain-app/src/features/customers/customer.ts"),
      "import { z } from 'zod';\nexport const input = z.object({ name: z.string().trim().min(1), });\n",
    ),
  ]);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

const commandResult = (
  overrides: Partial<Awaited<ReturnType<RuntimeCommandExecutor["run"]>>> = {},
) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  nanoseconds: 17,
  ...overrides,
});

describe("fresh runtime execution", () => {
  it("copies and permission-hardens third-party dependencies without touching the source installation", async () => {
    const root = await temporaryRepository();
    const packageDirectory = resolve(root, "node_modules/example-package");
    const packageEntry = resolve(packageDirectory, "index.js");
    const binDirectory = resolve(root, "node_modules/.bin");
    const transientCache = resolve(root, "node_modules/.vite-temp");
    await Promise.all([
      mkdir(packageDirectory, { recursive: true }),
      mkdir(binDirectory, { recursive: true }),
      mkdir(transientCache, { recursive: true }),
    ]);
    await writeFile(packageEntry, "export const source = 'original';\n");
    await writeFile(resolve(transientCache, "stale.mjs"), "stale\n");
    await chmod(packageEntry, 0o744);
    await symlink("../example-package/index.js", resolve(binDirectory, "example-command"));

    const isolated = await createIsolatedRepository(root);
    try {
      const isolatedPackage = resolve(isolated.root, "node_modules/example-package");
      const isolatedEntry = resolve(isolatedPackage, "index.js");
      const isolatedBin = resolve(isolated.root, "node_modules/.bin/example-command");

      expect((await lstat(isolatedPackage)).isSymbolicLink()).toBe(false);
      expect(await realpath(isolatedBin)).toBe(await realpath(isolatedEntry));
      await expect(access(resolve(isolated.root, "node_modules/.vite-temp")))
        .rejects.toThrow();
      expect((await stat(resolve(isolated.root, "node_modules"))).mode & 0o222).toBe(0);
      expect((await stat(isolatedPackage)).mode & 0o222).toBe(0);
      expect((await stat(isolatedEntry)).mode & 0o222).toBe(0);
      expect((await stat(isolatedEntry)).mode & 0o111).not.toBe(0);

      expect((await stat(packageDirectory)).mode & 0o200).not.toBe(0);
      expect((await stat(packageEntry)).mode & 0o200).not.toBe(0);
      await writeFile(packageEntry, "export const source = 'mutated';\n");
      await expect(readFile(isolatedEntry, "utf8"))
        .resolves.toBe("export const source = 'original';\n");
    } finally {
      await isolated.dispose();
    }
  });

  it("fails closed when a copied dependency contains a link outside the isolated repository", async () => {
    const root = await temporaryRepository();
    const packageDirectory = resolve(root, "node_modules/example-package");
    const sharedTarget = resolve(root, "shared-target.js");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(sharedTarget, "shared\n");
    await symlink(sharedTarget, resolve(packageDirectory, "escape.js"));

    await expect(createIsolatedRepository(root)).rejects.toThrow(
      /Copied dependency symlink escapes the isolated repository/u,
    );
  });

  it("retargets workspace dependencies and probes only freshly built output", async () => {
    const root = await temporaryRepository();
    await Promise.all([
      mkdir(resolve(root, "packages/core/src"), { recursive: true }),
      mkdir(resolve(root, "packages/core/dist"), { recursive: true }),
      mkdir(resolve(root, "examples/plain-app/dist"), { recursive: true }),
      mkdir(resolve(root, "node_modules/@agentixdev"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(resolve(root, "packages/core/package.json"), JSON.stringify({
        name: "@agentixdev/core",
        type: "module",
        exports: "./dist/index.js",
      })),
      writeFile(resolve(root, "packages/core/src/index.ts"), "export const source = 'source';\n"),
      writeFile(resolve(root, "packages/core/dist/index.js"), "export const sentinel = 'STALE-ROOT';\n"),
      writeFile(resolve(root, "examples/plain-app/dist/index.js"), "throw new Error('STALE APP DIST');\n"),
      symlink(
        resolve(root, "packages/core"),
        resolve(root, "node_modules/@agentixdev/core"),
        "dir",
      ),
    ]);

    let isolatedRoot = "";
    const executor: RuntimeCommandExecutor = {
      kind: "test-double",
      async run(cwd, argv) {
        isolatedRoot = cwd;
        expect(argv).toEqual([
          "npm", "run", "build", "--workspace", "@agentixdev/plain-app",
        ]);
        await expect(access(resolve(cwd, "examples/plain-app/dist"))).rejects.toThrow();
        await expect(access(resolve(cwd, "packages/core/dist"))).rejects.toThrow();
        await Promise.all([
          mkdir(resolve(cwd, "examples/plain-app/dist"), { recursive: true }),
          mkdir(resolve(cwd, "packages/core/dist"), { recursive: true }),
        ]);
        await Promise.all([
          writeFile(
            resolve(cwd, "examples/plain-app/dist/index.js"),
            "import { sentinel } from '@agentixdev/core';\nexport const createPlainSystem = () => ({ sentinel });\n",
          ),
          writeFile(
            resolve(cwd, "packages/core/dist/index.js"),
            "export const sentinel = 'FRESH-ISOLATED';\n",
          ),
        ]);
        return commandResult();
      },
    };

    const build = await prepareBuiltArm({ repositoryRoot: root, arm: "plain", executor });
    expect(build.ok).toBe(true);
    if (!build.ok) throw new Error(build.reason);
    try {
      expect(await realpath(resolve(
        build.isolatedRoot,
        "node_modules/@agentixdev/core",
      ))).toBe(await realpath(resolve(build.isolatedRoot, "packages/core")));
      expect(build.evidence.entrySha256).toBe(sha256(
        "import { sentinel } from '@agentixdev/core';\nexport const createPlainSystem = () => ({ sentinel });\n",
      ));
      expect(build.evidence.workspaceOutputManifestSha256).toMatch(/^[a-f0-9]{64}$/u);

      // Mutate/remove the original outputs after binding the isolated build. A
      // probe must still resolve both the app and its workspace dependency in
      // the isolated repository.
      await rm(resolve(root, "examples/plain-app/dist"), { recursive: true });
      await writeFile(
        resolve(root, "packages/core/dist/index.js"),
        "export const sentinel = 'MUTATED-ROOT';\n",
      );
      const cold = await coldStartProbe(build, systemCommandExecutor);
      expect(cold).toMatchObject({ exitCode: 0, reason: null });
      const resolutionProbe = await systemCommandExecutor.run(isolatedRoot, [
        process.execPath,
        "--input-type=module",
        "--eval",
        "const mod = await import(process.argv[1]); process.stdout.write(mod.createPlainSystem().sentinel);",
        build.entryPath,
      ]);
      expect(resolutionProbe).toMatchObject({ exitCode: 0, stdout: "FRESH-ISOLATED" });
    } finally {
      await build.dispose();
    }
  });

  it("normalizes Node maxRSS to bytes and records explicit unsupported values", () => {
    expect(normalizeNodeMaxRss(123)).toEqual({ available: true, bytes: 125_952 });
    expect(normalizeNodeMaxRss(0)).toEqual({
      available: false,
      reason: "process.resourceUsage().maxRSS was unavailable or non-positive.",
    });
    expect(normalizeNodeMaxRss(Number.MAX_SAFE_INTEGER)).toEqual({
      available: false,
      reason: "process.resourceUsage().maxRSS could not be represented safely in bytes.",
    });
  });

  it("captures signed retained RSS and normalized process maxRSS from the child", async () => {
    const build = {
      ok: true,
      implementation: "plain",
      isolatedRoot: "/isolated",
      entryPath: "/isolated/examples/plain-app/dist/index.js",
      evidence: {
        implementation: "plain",
        buildCommand: ["npm"],
        entryRelativePath: "examples/plain-app/dist/index.js",
        entrySha256: "0".repeat(64),
        outputManifestSha256: "0".repeat(64),
        workspaceOutputManifestSha256: "0".repeat(64),
        sourceManifestSha256: "0".repeat(64),
      },
      async dispose() {},
    } as const satisfies Extract<PreparedArmBuild, { readonly ok: true }>;
    const executor: RuntimeCommandExecutor = {
      kind: "test-double",
      async run(cwd, argv) {
        expect(cwd).toBe("/isolated");
        expect(argv).toContain("--expose-gc");
        return commandResult({
          stdout: JSON.stringify({ retainedRssBytes: -4_096, maxRssKiB: 321 }),
        });
      },
    };
    await expect(memoryProbe(build, executor)).resolves.toEqual({
      exitCode: 0,
      retainedRssBytes: -4_096,
      maxRss: { available: true, bytes: 328_704 },
      reason: null,
    });
  });
});

describe("isolated toolchain measurements", () => {
  it("runs every arm and toolchain command from fresh, dist-free workspaces", async () => {
    const root = await temporaryRepository();
    await mkdir(resolve(root, "examples/plain-app/dist"), { recursive: true });
    await writeFile(resolve(root, "examples/plain-app/dist/stale.js"), "stale\n");
    const commands: Array<{ cwd: string; argv: readonly string[] }> = [];
    const seenRoots = new Set<string>();
    const executor: RuntimeCommandExecutor = {
      kind: "test-double",
      async run(cwd, argv) {
        if (!seenRoots.has(cwd)) {
          seenRoots.add(cwd);
          expect(cwd).not.toBe(root);
          await expect(access(resolve(cwd, "examples/plain-app/dist"))).rejects.toThrow();
        }
        commands.push({ cwd, argv });
        return commandResult({ nanoseconds: 11 });
      },
    };

    await expect(measureToolchain({
      repositoryRoot: root, metric: "clean-build", arm: "plain", executor,
    })).resolves.toEqual({ ok: true, nanoseconds: 11 });
    await expect(measureToolchain({
      repositoryRoot: root, metric: "full-typecheck", arm: "framework", executor,
    })).resolves.toEqual({ ok: true, nanoseconds: 11 });
    await expect(measureToolchain({
      repositoryRoot: root, metric: "incremental-verification", arm: "framework", executor,
    })).resolves.toEqual({ ok: true, nanoseconds: 11 });
    await expect(measureToolchain({
      repositoryRoot: root, metric: "incremental-verification", arm: "plain", executor,
    })).resolves.toEqual({ ok: true, nanoseconds: 22 });

    expect(commands.map(({ argv }) => argv)).toEqual([
      ["npm", "run", "build", "--workspace", "@agentixdev/plain-app"],
      ["npm", "run", "build", "--workspace", "@agentixdev/compiler"],
      ["npm", "run", "typecheck", "--workspace", "@agentixdev/framework-app"],
      ["npm", "run", "build", "--workspace", "@agentixdev/cli"],
      ["npm", "run", "build", "--workspace", "@agentixdev/framework-app"],
      [
        process.execPath,
        "packages/cli/dist/bin.js",
        "verify",
        "customers.create",
        "--root",
        "examples/framework-app",
        "--json",
      ],
      ["npm", "run", "build", "--workspace", "@agentixdev/plain-app"],
      ["npm", "run", "typecheck", "--workspace", "@agentixdev/plain-app"],
      ["npm", "test", "--workspace", "@agentixdev/plain-app"],
    ]);
    expect(new Set(commands.map(({ cwd }) => cwd)).size).toBe(4);
  });

  it("turns prerequisite and measured command failures into non-numeric outcomes", async () => {
    const root = await temporaryRepository();
    const failing: RuntimeCommandExecutor = {
      kind: "test-double",
      async run() {
        return commandResult({ exitCode: 7, stderr: "synthetic failure", nanoseconds: 99 });
      },
    };
    const build = await prepareBuiltArm({ repositoryRoot: root, arm: "plain", executor: failing });
    expect(build).toMatchObject({ ok: false, exitCode: 7 });
    expect("nanoseconds" in build).toBe(false);

    const clean = await measureToolchain({
      repositoryRoot: root,
      metric: "clean-build",
      arm: "framework",
      executor: failing,
    });
    expect(clean).toMatchObject({ ok: false, exitCode: 7, stage: "measurement" });
    expect("nanoseconds" in clean).toBe(false);

    const fullTypecheck = await measureToolchain({
      repositoryRoot: root,
      metric: "full-typecheck",
      arm: "framework",
      executor: failing,
    });
    expect(fullTypecheck).toMatchObject({
      ok: false,
      exitCode: 7,
      stage: "prerequisite",
    });
    expect("nanoseconds" in fullTypecheck).toBe(false);

    const incremental = await measureToolchain({
      repositoryRoot: root,
      metric: "incremental-verification",
      arm: "plain",
      executor: failing,
    });
    expect(incremental).toMatchObject({ ok: false, exitCode: 7, stage: "prerequisite" });
    expect("nanoseconds" in incremental).toBe(false);
  });
});
