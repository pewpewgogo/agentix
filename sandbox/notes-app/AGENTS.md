# Agentix notes arm (v2)

Anonymous HTTP notes API: `POST /notes` (201, duplicate 409) and
`GET /notes/:id` (200/404); envelope `{ok:true,value}|{ok:false,error}`.

- `src/features/notes.ts` — schemas + `port.store` + `feature()` (one file).
- `src/app.ts` — `createApplication` + `createHttpHandler`; use `handler.fetch`.
- `src/notes.test.ts` (HTTP via `testHttp`) and `src/notes.dispatch.test.ts`
  (`app.call`); `associateOperationTest` markers link tests to operations.

TypeScript source is authoritative; `.agentix/index.json` is a digest-keyed
cache any CLI command refreshes — never read it whole. Start from:

```sh
node packages/cli/dist/bin.js inspect notes.create --root sandbox/notes-app --json --compact
```

Open the reported operation source; expand `affected`/omissions only when the
change needs it. Verify with:

```sh
npm run typecheck --workspace @agentix/sandbox-agentix-notes
npm test --workspace @agentix/sandbox-agentix-notes
```
