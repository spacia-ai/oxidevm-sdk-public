# OXVM CLI

Create and verify OXVM browser applications, images, snapshots, and WebAssembly modules.
Use Node.js 24 or newer.

```sh
npx @oxvm/cli@latest init my-app --start
```

With Bun:

```sh
bunx --package @oxvm/cli@latest oxvm init my-app --use-bun --start
```

Install matching SDK and CLI versions in an existing project:

```sh
npm install --save-exact @oxvm/sdk@latest @oxvm/cli@latest
npm exec -- oxvm --help
```

Fresh projects use `oxvm.config.ts` and `oxvm.lock.json`. Existing legacy
project files remain supported. Keep one coherent set of project files.

Read the [documentation](https://oxvm.dev/docs/) and
[migration guide](https://github.com/spacia-ai/oxvm-sdk-public/blob/main/docs/migration.md).
The CLI uses Apache-2.0. Engine and guest licenses remain separate.
