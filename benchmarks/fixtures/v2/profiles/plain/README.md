# Commerce application maintenance fixture

This workspace contains the strict TypeScript commerce application implemented
as a well-organized plain application: services, repositories, routes, and a
small HTTP router without an application framework. Use `npm run typecheck` and
`npm test` for the full checks.

The application entry point is `examples/plain-app`. Shared HTTP behavior is
declared by `examples/shared-contract`. Do not access the network or any path
outside this isolated workspace.
