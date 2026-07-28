# `@agentixdev/compiler`

Static analysis of [Agentix](https://pewpewgogo.github.io/agentix/) source into
a deterministic machine index, bounded per-operation context artifacts,
conservative affected-scope computation, and verification planning. Most
applications consume it through `@agentixdev/cli`; use this package directly for
custom tooling.

```sh
npm install --save-dev @agentixdev/compiler
```

Agentix is research-stage, ESM-only, and pre-1.0. The compiler pins TypeScript
compiler APIs and is especially subject to pre-1.0 change.

## Example

```ts
import {
  computeAffected,
  createOperationContext,
  generateIndex,
  planVerification,
} from "@agentixdev/compiler";

const rootDir = "/path/to/application";

// Deterministic index of features, operations, ports, events, tests, edges.
const { index } = generateIndex({ rootDir, write: true }); // .agentix/index.json

// Conservative change scope + the narrowest safe verification commands.
const affected = computeAffected(index, "notes.create", rootDir);
const plan = planVerification(index, "notes.create", rootDir, affected);
console.log(affected.widened, plan.typecheck, plan.tests);

// Bounded (<= 8 KiB) one-artifact change context with source excerpts.
const context = createOperationContext(index, "notes.create", rootDir);
if (context !== undefined) {
  console.log(context.http, context.errors, context.effects);
  console.log(context.excerpts?.input, context.excerpts?.execute);
  console.log(context.projection.omissions); // exact next action per omission
}
```

The index (schema version `"2"`) is a cache, not an authority: TypeScript
source is the source of truth, `checkIndexStaleness` compares a deterministic
source digest, and `readIndex` + staleness checking is the supported fast
path. Architecture rules (feature-file public contracts, no ambient
I/O/time/randomness in `src/features/`, query purity) surface as diagnostics
with stable codes via `analyzeProject` or `checkArchitecture`.

## Docs

- [API.md](API.md) — every export, one-line signatures (shipped with the package).
- [CLI guide](https://pewpewgogo.github.io/agentix/CLI.html) — the command
  surface over this package and all artifact shapes.
