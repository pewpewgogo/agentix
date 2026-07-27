# Agentix

Agentix is an agent-oriented TypeScript application framework: one feature is
one file, every boundary (schemas, errors, permissions, effects, routes) is
declared on the operation, and everything else — routing, adapter coverage,
dependency graphs, change scope — is derived from those declarations.
Application behavior stays in ordinary TypeScript.

[Documentation site](https://pewpewgogo.github.io/agentix/) ·
[Documentation source](docs/README.md) · [Getting started](docs/GETTING_STARTED.md) ·
[Authoring cheat sheet](docs/AUTHORING.md) · [API reference](docs/API_REFERENCE.md) ·
[Example application](examples/framework-app/src)

> **Project status:** Agentix is a research-stage, pre-1.0 framework. Public
> packages use coordinated versions under the `@agentix/*` npm scope. The API
> may change between minor releases until 1.0.

## A feature at a glance

```ts
import { command, feature, port, query, s } from "@agentix/core";

export const Note = s.object({
  id: s.string({ min: 1 }),
  title: s.string({ min: 1, trim: true }),
  body: s.string(),
});
export type Note = s.Infer<typeof Note>;

export const NoteStorage = port.store("noteStorage", Note);

export const notes = feature("notes", {
  operations: {
    create: command({
      input: Note,
      output: Note,
      errors: { NOTE_ALREADY_EXISTS: { http: 409, details: { id: s.string() } } },
      http: { method: "POST", path: "/notes", status: 201 },
      effects: { load: NoteStorage.get, save: NoteStorage.save },
      async execute({ input, effects, fail }) {
        if (await effects.load(input.id)) return fail("NOTE_ALREADY_EXISTS", { id: input.id });
        return effects.save(input);
      },
    }),
    get: query({
      input: s.object({ id: s.string({ min: 1 }) }),
      output: Note,
      errors: { NOTE_NOT_FOUND: { http: 404, details: { id: s.string() } } },
      http: { method: "GET", path: "/notes/:id" },
      effects: { load: NoteStorage.get },
      async execute({ input, effects, fail }) {
        return (await effects.load(input.id)) ?? fail("NOTE_NOT_FOUND", { id: input.id });
      },
    }),
  },
});
```

The app shell derives the rest — `POST /notes` answering 201/409 and
`GET /notes/:id` answering 200/404 with a fixed JSON envelope:

```ts
const app = createApplication({ features: [notes], adapters: [NoteStorage.memory()] });
const handler = createHttpHandler(app);
await serveNode(handler, { port: 3000 }); // or export handler.fetch on edge runtimes
```

No decorators, global registries, runtime source scans, or implicit lifecycle
hooks. Declared domain failures are typed outcome values; authorization and
invalid input are rejected dispatches; defects are faults (opaque 500s). The
compiler projects the same descriptors into a machine index, and the CLI turns
it into bounded change context: `agentix inspect notes.create` answers "what
does this operation touch and what is safe to verify" in one ≤8 KiB artifact.

## Install

Agentix requires Node.js `>=22.12.0 <25` (Node.js 22.12+ or 24). Install only
what the application needs:

```sh
npm install @agentix/core @agentix/adapters-http
npm install --save-dev @agentix/cli @agentix/testing
npm exec -- agentix help
```

To build and verify this repository with its pinned npm 11 toolchain:

```sh
git clone git@github.com:pewpewgogo/agentix.git
cd agentix
npm ci
npm run build
npm run verify
```

Explore the commerce example without reading the whole application:

```sh
npm exec -- agentix inspect orders.create --root examples/framework-app
npm exec -- agentix graph orders --root examples/framework-app
npm exec -- agentix affected src/features/orders.ts --root examples/framework-app
```

Compare the same notes behavior across Agentix, Express, and NestJS:

```sh
npm run sandbox:test
npm run sandbox:token-budget
npm run benchmark:http-frameworks -- --no-process
```

See the [three-arm benchmark runbook](benchmarks/THREE_ARM_RUNBOOK.md) before
interpreting calibration, runtime, or paid live-agent results.

## Packages

| Package | Responsibility |
| --- | --- |
| `@agentix/core` | `s` schemas, `command/query/feature/port/event` descriptors, outcomes, `createApplication`, `authorize`, dispatch |
| `@agentix/adapters-http` | Auto-derived routes, fixed JSON envelope, `serveNode` raw Node host, edge-safe `fetch` entry |
| `@agentix/testing` | `createTestApplication` (auto-faked ports), `testHttp`, harnesses, deterministic capabilities, contracts |
| `@agentix/compiler` | Static analysis, deterministic `.agentix/index.json`, affected scope, bounded context artifacts |
| `@agentix/cli` | `inspect`, `context`, `graph`, `affected`, `verify`, `openapi`, `scaffold`, plus `mcp` — the same commands as a stdio MCP server for coding agents |

Each package ships its own `README.md` and `API.md`; the full surface is in
the [API reference](docs/API_REFERENCE.md).

## Documentation

- [Documentation map](docs/README.md)
- [Getting started](docs/GETTING_STARTED.md)
- [Authoring cheat sheet](docs/AUTHORING.md) — read before the first change
- [Core concepts and execution model](docs/CORE_CONCEPTS.md)
- [HTTP adapter](docs/HTTP.md)
- [Testing](docs/TESTING.md)
- [CLI and generated index](docs/CLI.md)
- [API reference](docs/API_REFERENCE.md)
- [Repository development](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md) — frozen v1 experiment record with an
  appended, dated v2 revision; use the guides above for current behavior

## What the local evidence shows

Exploratory, single-machine measurements against Express 5 and NestJS 11
implementing the same behavior (see the caveats in the linked reports before
quoting them):

**Context cost** — three notes apps with identical behavior, estimated tokens
(`ceil(chars/4)`, [methodology](sandbox/README.md)):

| Scenario | Agentix | Express | NestJS |
| --- | ---: | ---: | ---: |
| Full source, like-for-like | **762** | 780 | 859 |
| "What is affected by this change?" | **62** | 635 | 635 |
| Add-an-endpoint: files read (tokens) | **644** | 741 | 733 |
| Add-an-endpoint: files written | **2** | 3 | 3 |

**Runtime** — isolated-process medians, 300 iterations, equal validation work
([full report](docs/HTTP_FRAMEWORK_BENCHMARK.md)):

| Workload | Agentix | Express | NestJS |
| --- | ---: | ---: | ---: |
| POST echo (valid) | **101.7 µs** | 121.3 µs | 130.0 µs |
| GET with path param | **62.1 µs** | 69.6 µs | 81.9 µs |
| 8 in-flight batch | **264.1 µs** | 317.3 µs | 346.5 µs |
| Cold start to ready | **37.9 ms** | 74.8 ms | 150.7 ms |
| Ready RSS | **61.6 MiB** | 79.7 MiB | 99.5 MiB |

## Research status

Agentix was built to test a falsifiable hypothesis: explicit feature capsules
and machine-readable dependency metadata may reduce the context coding agents
need for maintenance without reducing correctness. The framework and plain
TypeScript commerce applications pass the same black-box acceptance suite, but
the 100-run confirmatory agent-maintenance experiment has **not** been run.
The current verdict is `INCONCLUSIVE`.

The v2 redesign (single-file features, derived registration, HTTP fast path)
was validated against adversarial design reviews and exploratory local
measurements only. The Agentix/Express/NestJS HTTP comparison is an
exploratory runtime microbenchmark, not evidence for agent-maintenance
efficiency; read its methods and limitations in the
[HTTP framework benchmark report](docs/HTTP_FRAMEWORK_BENCHMARK.md).

The preregistered evidence boundary lives in:

- [Hypothesis](docs/HYPOTHESIS.md)
- [Benchmark protocol](docs/BENCHMARK_PROTOCOL.md)
- [Phase 5 readiness](docs/PHASE5_READINESS.md) — historical gate snapshot
- [Limitations](docs/LIMITATIONS.md) — frozen threats-to-validity record
- [Decision log](docs/DECISIONS.md)

The documentation is published with GitHub Pages. Framework releases are
versioned together and published to npm with provenance through the automated
[release workflow](docs/RELEASING.md). Benchmark evidence remains
repository-local and is never published as framework package content.
