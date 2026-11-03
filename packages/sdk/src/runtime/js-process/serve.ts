import type { LinuxProcessContext } from "../../js-process-types.js";
import { exactKeys, integer, record } from "../decode.js";
import { serializeUnknownError, VMError } from "../errors.js";
import { descriptor, JS_PROCESS_PROTOCOL_VERSION, protocol } from "./codec.js";
import { asyncFiles, syncFiles } from "./files.js";
import { decodeRunnerLaunch, type RunnerLaunch } from "./launch.js";
import { process } from "./process.js";
import { sockets } from "./sockets.js";
import { LinuxClient } from "./transport.js";

/** Serve one trusted application-bundled worker as a Rust-owned Linux process. Its start message carries the
 * process's port, mailbox and signal buffer (JS process protocol 5); a module runner's `launch` is refused. */
export function serveOwnedProcess(handler: (client: LinuxClient, context: LinuxProcessContext) => unknown): void {
  serve(false, (client, context) => handler(client, context));
}

/** The module runner's bootstrap: the same start message, plus the `launch` only the SDK's runner receives (engine ADR 0027). */
export function serveRunnerProcess(handler: (client: LinuxClient, context: LinuxProcessContext, launch: RunnerLaunch | undefined) => unknown): void {
  serve(true, handler);
}

function serve(runner: boolean, handler: (client: LinuxClient, context: LinuxProcessContext, launch: RunnerLaunch | undefined) => unknown): void {
  let started = false;
  self.onmessage = (event: MessageEvent<unknown>) => {
    const run = async () => {
      if (started) protocol("A JS worker can serve only one Linux process"); started = true;
      const start = record(event.data, "JS process bootstrap");
      exactKeys(start, ["version", "type", "port", "mailbox", "signals"], runner ? ["launch"] : []);
      if (start["version"] !== JS_PROCESS_PROTOCOL_VERSION || start["type"] !== "start" || !(start["port"] instanceof MessagePort) || !(start["mailbox"] instanceof SharedArrayBuffer) || !(start["signals"] instanceof SharedArrayBuffer)) protocol("JS process bootstrap version or fields are invalid");
      const launch = start["launch"] === undefined ? undefined : decodeRunnerLaunch(start["launch"]);
      const client = new LinuxClient(start["port"], start["mailbox"], start["signals"]), files = asyncFiles(client);
      const context: LinuxProcessContext = { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), files, filesSync: syncFiles(client), sockets: sockets(client, files), process: process(client) };
      try {
        const code = await handler(client, context, launch);
        self.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: code === undefined ? 0 : integer(code, "JS process exit status", 0, 255) });
      } finally { client.dispose(); }
    };
    void run().catch((error: unknown) => self.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "failure", error: serializeUnknownError(error instanceof Error ? error : new VMError("VM_FAULT", "JS process failed")) }));
  };
}
