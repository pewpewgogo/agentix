import { analyzeProject, computeAffected, planVerification } from "../packages/compiler/dist/index.js";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("./app1", import.meta.url));
const index = analyzeProject({ rootDir });

console.log("features:", index.features.map((f) => ({ id: f.id, deps: f.dependencies, consumers: f.consumers, tests: f.tests })));
console.log("operations:", index.operations.map((o) => ({ id: o.id, feature: o.feature, tests: o.tests })));
console.log("diagnostics:", index.diagnostics);
console.log("unresolved:", index.unresolved);

const affected = computeAffected(index, "first", rootDir);
console.log("affected(first) widened:", affected.widened, "wholeWorkspace:", affected.wholeWorkspace ?? false);
console.log("affected items:", affected.items ?? affected);

const plan = planVerification(index, "first", rootDir, affected);
console.log("plan:", JSON.stringify(plan, null, 2));
