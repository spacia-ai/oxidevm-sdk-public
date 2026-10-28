import type { JSProcessHandler } from "./js-process-types.js";
import { serveOwnedProcess } from "./runtime/js-process/serve.js";
export type * from "./js-process-types.js";
export { LinuxError } from "./runtime/js-process/codec.js";

/** Serve one trusted application-bundled worker as a Rust-owned Linux process. */
export function serveProcess(handler: JSProcessHandler): void {
  serveOwnedProcess((_client, context) => handler(context));
}
