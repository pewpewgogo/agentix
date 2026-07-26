import { analyzeProject, computeAffected } from "/Users/mac/WebstormProjects/agentix/.claude/worktrees/agent-first-framework-overhaul/packages/compiler/dist/index.js";
const rootDir = "/Users/mac/WebstormProjects/agentix/.claude/worktrees/agent-first-framework-overhaul/.final-review-probe/refute-92092/fixture";
const index = analyzeProject({ rootDir });
const create = index.operations.find((o) => o.id === "customers.create");
console.log("create.effects:", JSON.stringify(create?.effects));
console.log("diagnostics:", JSON.stringify(index.diagnostics));
console.log("unresolved:", JSON.stringify(index.unresolved));
const affected = computeAffected(index, "customerStore.save", rootDir);
console.log("affected(customerStore.save):", JSON.stringify(affected, null, 1));
