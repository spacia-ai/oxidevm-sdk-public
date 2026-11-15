# OXVM SDK

Run Linux tools inside a browser application with the framework-independent OXVM SDK.

```sh
npm install @oxvm/sdk
```

```ts
import { createVM } from "@oxvm/sdk";
```

Start a complete application with `npx @oxvm/cli@latest init my-app --start`.
Use Node.js 24 or newer for the CLI and image builder.

The package exports the SDK, JavaScript processes, image builder, machine,
diagnostics, WebAssembly modules, and module testing APIs. Keep browser imports
separate from the Node-only `@oxvm/sdk/image-builder` export.

Read the [quickstart](https://oxvm.dev/docs/start/quickstart/),
[documentation](https://oxvm.dev/docs/), and
[migration guide](https://github.com/spacia-ai/oxidevm-sdk-public/blob/main/docs/migration.md).

The SDK uses Apache-2.0. The engine and guest programs have separate licenses.
Keep the packaged notices and source references with redistributed code.
