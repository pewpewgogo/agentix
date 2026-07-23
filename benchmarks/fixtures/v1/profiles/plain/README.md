# Commerce application maintenance fixture

This workspace contains a well-organized strict TypeScript commerce application
with runtime validation, explicit constructor injection, a small HTTP router,
and in-memory infrastructure. Use `npm run typecheck` and `npm test` for the
full checks.

The application entry point is `examples/plain-app`. Shared HTTP behavior is
declared by `examples/shared-contract`. Do not access the network or any path
outside this isolated workspace.
