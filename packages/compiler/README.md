# `@agentix/compiler`

Static architecture analysis and bounded operation-context projection for
[Agentix](https://pewpewgogo.github.io/agentix/) applications.

Most applications use this package through `@agentix/cli`:

```sh
npm install --save-dev @agentix/cli
npm exec -- agentix inspect <operation-id> --root <application>
```

Agentix is research-stage, ESM-only, and pre-1.0. The compiler uses pinned
TypeScript compiler APIs and is especially subject to pre-1.0 change.
