# Commerce application maintenance fixture

This workspace contains the strict TypeScript commerce application organized as
feature capsules plus its local framework packages. Use `npm run typecheck` and
`npm test` for the full checks. The `agentix` inspect, affected, and verify
commands are available as application discovery tools; their output and any
documentation read by an agent count as normal benchmark context.

The application entry point is `examples/framework-app`. Shared HTTP behavior is
declared by `examples/shared-contract`. Do not access the network or any path
outside this isolated workspace.
