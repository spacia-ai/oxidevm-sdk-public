import type { LinuxProcessContext } from "../../js-process-types.js";
import { exactKeys, integer, record } from "../decode.js";
import { serializeUnknownError, VMError } from "../errors.js";
import { descriptor, JS_PROCESS_PROTOCOL_VERSION, protocol } from "./codec.js";
import { asyncFiles, syncFiles } from "./files.js";
import { process } from "./process.js";
import { sockets } from "./sockets.js";
import { LinuxClient } from "./transport.js";

/** Serve one trusted application-bundled worker as a Rust-owned Linux process. */
export function serveOwnedProcess(handler: (client: LinuxClient, context: LinuxProcessContext) => unknown): void {
  let started = false;
  self.onmessage = (event: MessageEvent<unknown>) => {
    const run = async () => {
      if (started) protocol("A JS worker can serve only one Linux process"); started = true;
      const start = record(event.data, "JS process bootstrap");
      exactKeys(start, ["version", "type", "port", "mailbox"]);
      if (start["version"] !== JS_PROCESS_PROTOCOL_VERSION || start["type"] !== "start" || !(start["port"] instanceof MessagePort) || !(start["mailbox"] instanceof SharedArrayBuffer)) protocol("JS process bootstrap version or fields are invalid");
      const client = new LinuxClient(start["port"], start["mailbox"]), files = asyncFiles(client);
      const context: LinuxProcessContext = { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), files, filesSync: syncFiles(client), sockets: sockets(client, files), process: process(client) };
      try {
        const code = await handler(client, context);
        self.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code: code === undefined ? 0 : integer(code, "JS process exit status", 0, 255) });
      } finally { client.dispose(); }
    };
    void run().catch((error: unknown) => self.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "failure", error: serializeUnknownError(error instanceof Error ? error : new VMError("VM_FAULT", "JS process failed")) }));
  };
}
