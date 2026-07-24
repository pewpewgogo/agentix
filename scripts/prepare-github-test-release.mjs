import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageSpecs = [
  ["@agentix/core", "packages/core"],
  ["@agentix/compiler", "packages/compiler"],
  ["@agentix/cli", "packages/cli"],
  ["@agentix/testing", "packages/testing"],
  ["@agentix/adapters-http", "packages/adapters-http"],
];
const publicPackageNames = new Set(packageSpecs.map(([name]) => name));

const options = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`Expected --name=value argument, received ${argument}`);
    }
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  }),
);

const version = options.get("version");
const tag = options.get("tag");
const repository = options.get("repository") ?? "pewpewgogo/agentix";
const output = resolve(
  root,
  options.get("output") ?? ".agentix-tmp/github-test-release",
);

if (version === undefined || !/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/u.test(version)) {
  throw new Error("--version must be a valid prerelease version");
}
if (tag === undefined || tag !== `github-test-v${version}`) {
  throw new Error("--tag must equal github-test-v<version>");
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  throw new Error("--repository must use owner/name syntax");
}
if (!output.startsWith(`${root}/.agentix-tmp/`)) {
  throw new Error("--output must stay inside .agentix-tmp");
}

const assetBase = `https://github.com/${repository}/releases/download/${tag}`;
const filenameFor = (name) =>
  `${name.slice(1).replace("/", "-")}-${version}.tgz`;

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const packages = [];
for (const [name, directory] of packageSpecs) {
  const source = resolve(root, directory);
  const staging = resolve(output, "staging", name.slice(1).replace("/", "-"));
  await mkdir(staging, { recursive: true });
  await cp(resolve(source, "dist"), resolve(staging, "dist"), {
    recursive: true,
    filter: (path) =>
      !path.includes(".tsbuildinfo") &&
      !path.endsWith(".map") &&
      !/(?:^|\/)\w+\.test\.(?:js|d\.ts)(?:\.map)?$/u.test(path) &&
      !/(?:^|\/)[^/]* [^/]*$/u.test(path),
  });
  await cp(resolve(source, "README.md"), resolve(staging, "README.md"));
  await cp(resolve(source, "LICENSE"), resolve(staging, "LICENSE"));

  const manifest = JSON.parse(
    await readFile(resolve(source, "package.json"), "utf8"),
  );
  manifest.version = version;
  delete manifest.private;
  delete manifest.devDependencies;
  delete manifest.scripts;
  delete manifest.files;
  delete manifest.publishConfig;

  for (const [dependency] of Object.entries(manifest.dependencies ?? {})) {
    if (publicPackageNames.has(dependency)) {
      manifest.dependencies[dependency] =
        `${assetBase}/${filenameFor(dependency)}`;
    }
  }
  await writeFile(
    resolve(staging, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const packed = spawnSync(
    "npm",
    [
      "pack",
      staging,
      "--pack-destination",
      output,
      "--json",
      "--ignore-scripts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed for ${name}: ${packed.stderr.trim()}`);
  }

  const [report] = JSON.parse(packed.stdout);
  const expectedFilename = filenameFor(name);
  if (report.filename !== expectedFilename) {
    throw new Error(
      `${name} produced ${report.filename}; expected ${expectedFilename}`,
    );
  }
  const paths = report.files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
    if (!paths.includes(required)) {
      throw new Error(`${name} test tarball is missing ${required}`);
    }
  }
  const forbidden = paths.find(
    (path) =>
      path.startsWith("src/") ||
      path.includes(".tsbuildinfo") ||
      path.endsWith(".map") ||
      /(?:^|\/)\w+\.test\.(?:js|d\.ts)(?:\.map)?$/u.test(path) ||
      /(?:^|\/)[^/]* [^/]*$/u.test(path),
  );
  if (forbidden !== undefined) {
    throw new Error(`${name} test tarball contains ${forbidden}`);
  }

  packages.push({
    name,
    version,
    filename: expectedFilename,
    url: `${assetBase}/${expectedFilename}`,
    integrity: report.integrity,
    size: report.size,
  });
}

const packageByName = new Map(packages.map((entry) => [entry.name, entry]));
const runtimePackages = ["@agentix/core", "@agentix/adapters-http"]
  .map((name) => packageByName.get(name).url)
  .join(" ");
const developmentPackages = ["@agentix/cli", "@agentix/testing"]
  .map((name) => packageByName.get(name).url)
  .join(" ");
const notes = `# Agentix GitHub test packages ${version}

These immutable tarballs are a test channel built from commit
\`${process.env.GITHUB_SHA ?? "local checkout"}\`. They are not an npm registry
release and carry no compatibility promise beyond the source revision.

Install without GitHub Packages authentication:

\`\`\`sh
npm install ${runtimePackages}
npm install --save-dev ${developmentPackages}
npm exec -- agentix help
\`\`\`

The installed package names remain \`@agentix/core\`,
\`@agentix/adapters-http\`, \`@agentix/cli\`, and \`@agentix/testing\`.
Internal package dependencies resolve to immutable assets from this release.
`;

await writeFile(resolve(output, "release-notes.md"), notes);
await writeFile(
  resolve(output, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      repository,
      tag,
      version,
      sourceRevision: process.env.GITHUB_SHA ?? null,
      packages,
    },
    null,
    2,
  )}\n`,
);
await rm(resolve(output, "staging"), { recursive: true, force: true });

console.log(`Prepared ${packages.length} GitHub test packages at ${output}.`);
