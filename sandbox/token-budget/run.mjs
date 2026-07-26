import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resultsRoot = resolve(repositoryRoot, "sandbox/token-budget/results");
const cli = resolve(repositoryRoot, "packages/cli/dist/bin.js");

const arms = {
  agentix: {
    root: "sandbox/notes-app",
    recommendedFiles: ["AGENTS.md", "src/features/notes.ts"],
  },
  express: {
    root: "sandbox/plain-notes-app",
    recommendedFiles: ["AGENTS.md", "src/note.ts", "src/notes-service.ts", "src/app.ts", "src/notes.test.ts"],
  },
  nestjs: {
    root: "sandbox/nestjs-notes-app",
    recommendedFiles: ["AGENTS.md", "src/note.ts", "src/notes.service.ts", "src/notes.controller.ts", "src/notes.test.ts"],
  },
};

const read = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");

const walkFiles = (directory) => {
  const result = [];
  for (const entry of readdirSync(resolve(repositoryRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (![".agentix", "dist", "node_modules"].includes(entry.name)) {
        result.push(...walkFiles(path));
      }
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result.sort();
};

const sourceFiles = (arm) => walkFiles(`${arm.root}/src`)
  .filter((path) => path.endsWith(".ts"));

const sumCharacters = (parts) => parts.reduce((total, part) => total + part.length, 0);
const measure = (parts) => {
  const characters = sumCharacters(parts);
  return { characters, estimatedTokens: Math.ceil(characters / 4) };
};

const runAgentix = (args) => execFileSync(
  process.execPath,
  [cli, ...args],
  { cwd: repositoryRoot, encoding: "utf8" },
);

const inspect = runAgentix([
  "inspect",
  "notes.create",
  "--root",
  "sandbox/notes-app",
  "--json",
  "--compact",
]);
const affected = runAgentix([
  "affected",
  "notes.create",
  "--root",
  "sandbox/notes-app",
]);

const discovery = (arm) => {
  const files = sourceFiles(arm);
  const declarations = files.flatMap((path) => read(path)
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /\b(?:create|get)\b|class Notes|@(?:Post|Get)\b/u.test(line))
    .map(({ line, index }) => `${relative(arm.root, path)}:${index}:${line.trim()}\n`));
  return [`${files.map((path) => `${relative(arm.root, path)}\n`).join("")}`, ...declarations];
};

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  estimator: "ceil(UTF-16 characters / 4); calibration only, not provider telemetry",
  operation: "notes.create",
  scenarios: {},
  composition: {
    "recommended-agent-path": "arm AGENTS.md plus the arm's declared bounded source pack; Agentix also includes compact inspect output",
    discovery: "Agentix compact inspect output; conventional arms use deterministic source inventory and matching declarations",
    affected: "Agentix affected output; conventional arms conservatively include their complete TypeScript source tree",
    "full-src": "all TypeScript files under the arm's src directory",
    "naive-worst": "all non-generated project files; Agentix additionally includes the generated index to expose the cost of the discouraged path",
  },
};

for (const [name, arm] of Object.entries(arms)) {
  const sources = sourceFiles(arm).map(read);
  const project = walkFiles(arm.root).map(read);
  const recommended = arm.recommendedFiles.map((path) => read(`${arm.root}/${path}`));
  result.scenarios[name] = {
    "recommended-agent-path": measure(name === "agentix" ? [...recommended, inspect] : recommended),
    discovery: measure(name === "agentix" ? [inspect] : discovery(arm)),
    affected: measure(name === "agentix" ? [affected] : sources),
    "full-src": measure(sources),
    "naive-worst": measure(
      name === "agentix"
        ? [...project, read(`${arm.root}/.agentix/index.json`)]
        : project,
    ),
  };
}

const scenarioOrder = [
  "recommended-agent-path",
  "discovery",
  "affected",
  "full-src",
  "naive-worst",
];
const markdown = [
  "# Three-arm token-budget calibration",
  "",
  `Generated: ${result.generatedAt}`,
  "",
  "Heuristic only: `ceil(characters / 4)`. Live runs must use provider-reported token counters.",
  "",
  "| Scenario | Agentix | Express | NestJS |",
  "| --- | ---: | ---: | ---: |",
  ...scenarioOrder.map((scenario) =>
    `| ${scenario} | ${result.scenarios.agentix[scenario].estimatedTokens} | ${result.scenarios.express[scenario].estimatedTokens} | ${result.scenarios.nestjs[scenario].estimatedTokens} |`
  ),
  "",
  "## Composition",
  "",
  ...Object.entries(result.composition).map(([scenario, description]) =>
    `- **${scenario}:** ${description}.`
  ),
  "",
].join("\n");

mkdirSync(resultsRoot, { recursive: true });
writeFileSync(
  resolve(resultsRoot, "token-budget-latest.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  { encoding: "utf8" },
);
writeFileSync(
  resolve(resultsRoot, "token-budget-latest.md"),
  markdown,
  { encoding: "utf8" },
);
process.stdout.write(markdown);
