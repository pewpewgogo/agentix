# Commerce application maintenance fixture

This workspace contains the strict TypeScript commerce application built with
the Agentix framework plus its local framework packages. Each feature is a
single module under `examples/framework-app/src/features/` that declares its
schemas, ports, operations, permissions, HTTP bindings, and effects together.
Use `npm run typecheck` and `npm test` for the full checks. The `agentix`
inspect, context, affected, and verify commands are available as application
discovery tools; their output and any documentation read by an agent count as
normal benchmark context.

The application entry point is `examples/framework-app`. Shared HTTP behavior is
declared by `examples/shared-contract`. Do not access the network or any path
outside this isolated workspace.
