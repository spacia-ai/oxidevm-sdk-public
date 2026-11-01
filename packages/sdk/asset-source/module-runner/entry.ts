import { serveOwnedProcess } from "../../src/runtime/js-process/serve.ts";
import { browserContext } from "../../src/wasm/runner/browser.ts";
import { runModule } from "../../src/wasm/runner/run.ts";

// The SDK-owned worker behind `spawnModule`. `serveOwnedProcess` installs `onmessage` synchronously, so
// the engine's start message cannot arrive before a handler exists; everything else happens in `runModule`.
serveOwnedProcess((_client, context) => runModule(browserContext(context)));
