import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resultsRoot = resolve(repositoryRoot, "sandbox/token-budget/results");
const cli = resolve(repositoryRoot, "packages/cli/dist/bin.js");

const estimator = {
  version: "chars-div-4/v2",
  method: "ceil(UTF-16 characters / 4)",
  caveat:
    "Heuristic calibration only, not provider telemetry; live comparisons must use provider-reported token counters.",
};

const operation = "notes.create";
const changeTaskDescription = "add a notes.delete endpoint";

// Declarative per-arm model. The script MEASURES everything from this model —
// no scenario number is hardcoded.
//
// - comparableTest: the ONE test counted in the like-for-like full-src number.
//   Agentix uses its call-level dispatch test because that exercises the same
//   layer as the Express/NestJS supertest suites (service behavior + envelope);
//   its extra HTTP end-to-end test is reported separately as informational.
// - changeTask.readStrategies: per-strategy context an agent must load to
//   perform the scripted change task. Every arm's baseline strategy is
//   "direct": exactly the files that arm's conventions require opening
//   (Agentix auto-wiring means the app assembly is never read or written;
//   Express routes live in app.ts so it must be read). Agentix additionally
//   reports "inspect-assisted": the direct reads plus the compact inspect
//   output — the discovery tool that substitutes for reading wiring in larger
//   apps, charged here at its full fixed cost.
//   cliReads are Agentix CLI invocations whose stdout is charged.
// - changeTask.write: the files the agent modifies for the task; the script
//   derives the write count and current-size proxy from this list.
const arms = {
  agentix: {
    root: "sandbox/notes-app",
    comparableTest: "src/notes.dispatch.test.ts",
    informationalExtraTests: ["src/notes.test.ts"],
    changeTask: {
      readStrategies: [
        {
          name: "direct",
          cliReads: [],
          files: ["src/features/notes.ts", "src/notes.dispatch.test.ts"],
        },
        {
          name: "inspect-assisted",
          cliReads: [
            ["inspect", operation, "--root", "sandbox/notes-app", "--json", "--compact"],
          ],
          files: ["src/features/notes.ts", "src/notes.dispatch.test.ts"],
        },
      ],
      write: ["src/features/notes.ts", "src/notes.dispatch.test.ts"],
    },
  },
  express: {
    root: "sandbox/plain-notes-app",
    comparableTest: "src/notes.test.ts",
    informationalExtraTests: [],
    changeTask: {
      readStrategies: [
        {
          name: "direct",
          cliReads: [],
          files: ["src/note.ts", "src/notes-service.ts", "src/app.ts", "src/notes.test.ts"],
        },
      ],
      write: ["src/notes-service.ts", "src/app.ts", "src/notes.test.ts"],
    },
  },
  nestjs: {
    root: "sandbox/nestjs-notes-app",
    comparableTest: "src/notes.test.ts",
    informationalExtraTests: [],
    changeTask: {
      readStrategies: [
        {
          name: "direct",
          cliReads: [],
          files: ["src/note.ts", "src/notes.service.ts", "src/notes.controller.ts", "src/notes.test.ts"],
        },
      ],
      write: ["src/notes.service.ts", "src/notes.controller.ts", "src/notes.test.ts"],
    },
  },
};

const read = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");

// Walks committed project files only; generated/gitignored outputs
// (.agentix cache, dist, node_modules) never enter any measurement.
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

const sourceFiles = (arm) => walkFiles(`${arm.root}/src`).filter((path) => path.endsWith(".ts"));
const isTestFile = (path) => path.endsWith(".test.ts");

const sumCharacters = (parts) => parts.reduce((total, part) => total + part.length, 0);
const measure = (parts) => {
  const characters = sumCharacters(parts);
  return { characters, estimatedTokens: Math.ceil(characters / 4) };
};

const runAgentix = (args) =>
  execFileSync(process.execPath, [cli, ...args], { cwd: repositoryRoot, encoding: "utf8" });

// Scenario: full-src (like-for-like). All non-test src files + the ONE
// comparable test declared by the arm model.
const fullSrcScenario = (arm) => {
  const files = [
    ...sourceFiles(arm).filter((path) => !isTestFile(path)),
    `${arm.root}/${arm.comparableTest}`,
  ];
  const extras = arm.informationalExtraTests.map((path) => {
    const absolute = `${arm.root}/${path}`;
    return { file: path, ...measure([read(absolute)]) };
  });
  return {
    ...measure(files.map(read)),
    files: files.map((path) => relative(arm.root, path)),
    informationalExtraTests: extras,
  };
};

// Scenario: affected. Agentix answers with `agentix affected <operation>`.
// Conventional arms are modeled as the realistic agent strategy: list the src
// file inventory, grep it for the operation's local symbol, then open every
// matched file (grep hits alone do not establish relevance).
const affectedScenario = (arm, name) => {
  if (name === "agentix") {
    const output = runAgentix(["affected", operation, "--root", arm.root]);
    return { ...measure([output]), source: `agentix affected ${operation}` };
  }
  const symbol = operation.split(".").at(-1);
  const pattern = new RegExp(`\\b${symbol}\\b`, "u");
  const files = sourceFiles(arm);
  const inventory = `${files.map((path) => `${relative(arm.root, path)}\n`).join("")}`;
  const matched = files.filter((path) => pattern.test(read(path)));
  return {
    ...measure([inventory, ...matched.map(read)]),
    source: `src inventory + grep /\\b${symbol}\\b/ + matched file contents`,
    matchedFiles: matched.map((path) => relative(arm.root, path)),
  };
};

// Scenario: change-cost for the scripted task. READ = CLI outputs + files the
// model says the agent must open; WRITE = files the model says the task
// modifies (count derived, current sizes reported as a proxy).
const changeCostScenario = (arm) => {
  const read_ = {};
  for (const strategy of arm.changeTask.readStrategies) {
    const cliOutputs = strategy.cliReads.map((args) => runAgentix(args));
    const readFiles = strategy.files.map((path) => read(`${arm.root}/${path}`));
    read_[strategy.name] = {
      ...measure([...cliOutputs, ...readFiles]),
      cliReads: strategy.cliReads.map((args) => `agentix ${args.join(" ")}`),
      files: strategy.files,
    };
  }
  return {
    task: changeTaskDescription,
    read: read_,
    write: {
      fileCount: arm.changeTask.write.length,
      files: arm.changeTask.write,
      currentSize: measure(arm.changeTask.write.map((path) => read(`${arm.root}/${path}`))),
    },
  };
};

const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

const result = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  gitCommit,
  nodeVersion: process.version,
  estimator,
  operation,
  changeTask: changeTaskDescription,
  scenarios: {},
  composition: {
    "full-src":
      "like-for-like: every non-test TypeScript file under src plus ONE comparable test per arm (Agentix: call-level notes.dispatch.test.ts, same layer as the conventional arms' suites; its HTTP end-to-end test is reported as an informational extra, outside the headline number)",
    affected:
      "Agentix: `agentix affected notes.create` output; conventional arms: src file inventory + grep for the operation symbol + full content of every matched file (the realistic grep strategy — a grep hit still requires opening the file)",
    "change-cost":
      "scripted task 'add a notes.delete endpoint'; READ (direct) = the files each arm's conventions require opening (Agentix: feature file + test, app assembly untouched by design; Express: schema/service/app routes/test; NestJS: schema/service/controller/test); READ (inspect-assisted, Agentix only) = direct reads plus compact inspect output, the discovery tool whose fixed cost substitutes for reading wiring in larger apps; WRITE = files modified. All derived from the declarative per-arm task model in run.mjs",
  },
};

for (const [name, arm] of Object.entries(arms)) {
  result.scenarios[name] = {
    "full-src": fullSrcScenario(arm),
    affected: affectedScenario(arm, name),
    "change-cost": changeCostScenario(arm),
  };
}

const armOrder = ["agentix", "express", "nestjs"];
const row = (label, pick) =>
  `| ${label} | ${armOrder.map((name) => pick(result.scenarios[name])).join(" | ")} |`;

const agentixExtras = result.scenarios.agentix["full-src"].informationalExtraTests;
const markdown = [
  "# Three-arm token-budget calibration",
  "",
  `Generated: ${result.generatedAt}`,
  `Commit: ${gitCommit}`,
  `Node: ${result.nodeVersion}`,
  `Estimator: ${estimator.version} — ${estimator.method}`,
  "",
  `${estimator.caveat}`,
  "",
  `Change task: ${changeTaskDescription}. Affected operation: ${operation}.`,
  "",
  "| Scenario | Agentix | Express | NestJS |",
  "| --- | ---: | ---: | ---: |",
  row("full-src est. tokens (like-for-like)", (s) => s["full-src"].estimatedTokens),
  row("affected est. tokens", (s) => s.affected.estimatedTokens),
  row("change-cost READ est. tokens (direct)", (s) => s["change-cost"].read.direct.estimatedTokens),
  row(
    "change-cost READ est. tokens (inspect-assisted)",
    (s) => s["change-cost"].read["inspect-assisted"]?.estimatedTokens ?? "—",
  ),
  row("change-cost WRITE (files modified)", (s) => s["change-cost"].write.fileCount),
  "",
  ...agentixExtras.map(
    (extra) =>
      `Informational (outside headline): Agentix HTTP end-to-end test \`${extra.file}\` adds ${extra.estimatedTokens} est. tokens (${extra.characters} chars).`,
  ),
  "",
  "## Composition",
  "",
  ...Object.entries(result.composition).map(
    ([scenario, description]) => `- **${scenario}:** ${description}.`,
  ),
  "",
].join("\n");

mkdirSync(resultsRoot, { recursive: true });
writeFileSync(resolve(resultsRoot, "token-budget-latest.json"), `${JSON.stringify(result, null, 2)}\n`, {
  encoding: "utf8",
});
writeFileSync(resolve(resultsRoot, "token-budget-latest.md"), markdown, { encoding: "utf8" });
process.stdout.write(markdown);
