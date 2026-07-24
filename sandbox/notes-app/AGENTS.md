# Agentix notes arm

This arm implements `notes.create` and `notes.get` with Agentix descriptors.
TypeScript source is authoritative; `.agentix/index.json` is disposable.

Start from bounded operation context:

```sh
npm exec -- agentix inspect notes.create --root sandbox/notes-app --json --compact
```

Open the reported operation source. Follow `affected` or an omission expansion
only when the requested change needs it. Never read the complete generated
index as agent context.

Verify with:

```sh
npm run typecheck --workspace @agentixdev/sandbox-agentix-notes
npm test --workspace @agentixdev/sandbox-agentix-notes
```
