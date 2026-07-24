import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  ["@agentix/core", "packages/core", ["dist/index.js", "dist/index.d.ts"]],
  [
    "@agentix/compiler",
    "packages/compiler",
    ["dist/index.js", "dist/index.d.ts"],
  ],
  [
    "@agentix/cli",
    "packages/cli",
    ["dist/index.js", "dist/index.d.ts", "dist/bin.js"],
  ],
  [
    "@agentix/testing",
    "packages/testing",
    ["dist/index.js", "dist/index.d.ts"],
  ],
  [
    "@agentix/adapters-http",
    "packages/adapters-http",
    [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/web.js",
      "dist/web.d.ts",
      "dist/node.js",
      "dist/node.d.ts",
    ],
  ],
];

const manifests = new Map();
const errors = [];

for (const [expectedName, directory] of packages) {
  const manifest = JSON.parse(
    await readFile(resolve(root, directory, "package.json"), "utf8"),
  );
  manifests.set(expectedName, manifest);

  if (manifest.name !== expectedName) {
    errors.push(`${directory}: expected name ${expectedName}`);
  }
  if (manifest.private === true) {
    errors.push(`${expectedName}: public package cannot be private`);
  }
  if (manifest.license !== "MIT") {
    errors.push(`${expectedName}: license must be MIT`);
  }
  if (manifest.engines?.node !== ">=24.0.0 <25") {
    errors.push(`${expectedName}: Node.js engine must match the release contract`);
  }
  if (
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.provenance !== true
  ) {
    errors.push(`${expectedName}: public access and provenance must be enabled`);
  }
  if (manifest.repository?.directory !== directory) {
    errors.push(`${expectedName}: repository.directory must be ${directory}`);
  }
}

const versions = new Set([...manifests.values()].map(({ version }) => version));
if (versions.size !== 1) {
  errors.push("public packages must use one coordinated version");
}

for (const [name, manifest] of manifests) {
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    const internal = manifests.get(dependency);
    if (internal === undefined) continue;
    const normalizedRange = range.replace(/^[~^]/u, "");
    if (normalizedRange !== internal.version) {
      errors.push(
        `${name}: ${dependency} range ${range} does not match ${internal.version}`,
      );
    }
  }
}

for (const [name, , requiredFiles] of packages) {
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--workspace", name],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    errors.push(`${name}: npm pack failed\n${result.stderr.trim()}`);
    continue;
  }

  let report;
  try {
    [report] = JSON.parse(result.stdout);
  } catch (error) {
    errors.push(`${name}: could not parse npm pack output: ${error.message}`);
    continue;
  }

  const files = new Map(report.files.map((file) => [file.path, file]));
  for (const required of ["package.json", "README.md", "LICENSE", ...requiredFiles]) {
    if (!files.has(required)) {
      errors.push(`${name}: package is missing ${required}`);
    }
  }

  for (const path of files.keys()) {
    if (
      path.startsWith("src/") ||
      path.includes(".tsbuildinfo") ||
      /(?:^|\/)\w+\.test\.(?:js|d\.ts)(?:\.map)?$/u.test(path)
    ) {
      errors.push(`${name}: package contains development artifact ${path}`);
    }
  }

  if (name === "@agentix/cli") {
    const binary = files.get("dist/bin.js");
    if (binary !== undefined && (binary.mode & 0o111) === 0) {
      errors.push(`${name}: dist/bin.js is not executable`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${packages.length} coordinated public package tarballs at ${[...versions][0]}.`,
  );
}
