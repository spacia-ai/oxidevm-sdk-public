import { VMError, serializeUnknownError } from "../../errors.js";
import { decodeRequestId, PROTOCOL_VERSION } from "../../protocol/common.js";
import { decodeInstallationCommand } from "../../protocol/dependency-installation.js";
import type { DependencyInstallHandle } from "../../vm-types.js";

/** One preparation port. Stream backpressure is native; terminal results retain
 * independent ownership until both have been delivered to the SDK. */
export function serveDependencyInstallation(port: MessagePort, preparing: Promise<DependencyInstallHandle>,
  cancel: () => void): () => void {
  let last = 0;
  let closed = false;
  let handle: DependencyInstallHandle | undefined;
  const used = new Set<string>();
  const active = new Map<string, number>();
  const delivered = new Set<string>();
  const close = () => {
    if (closed) return;
    closed = true;
    port.removeEventListener("message", receive);
    port.removeEventListener("messageerror", messageError);
    port.close();
  };
  const failed = (error: unknown, rejectedId?: number) => {
    if (closed) return;
    const ids = new Set(active.values());
    if (rejectedId !== undefined) ids.add(rejectedId);
    for (const id of ids) {
      try { port.postMessage({ version: PROTOCOL_VERSION, id, ok: false, error: serializeUnknownError(error) }); }
      catch { break; }
    }
    cancel(); close();
  };
  const messageError = () => failed(new VMError("PROTOCOL_ERROR", "Installation channel could not decode a message"));
  // Retain startup and terminal rejections even before the client requests them.
  void preparing.then(value => {
    handle = value;
    void value.exit.catch(() => {}); void value.generation.catch(() => {});
  }, () => {});
  const receive = (event: MessageEvent<unknown>) => {
    let command: ReturnType<typeof decodeInstallationCommand>;
    try {
      command = decodeInstallationCommand(event.data);
      if (command.id <= last || active.has(command.type) || (command.type !== "kill" && used.has(command.type))) {
        throw new VMError("PROTOCOL_ERROR", "Duplicate installation request");
      }
      last = command.id;
      used.add(command.type); active.set(command.type, command.id);
    } catch (error) {
      failed(error, decodeRequestId(event.data)); return;
    }
    void respond(command);
  };
  async function respond(command: ReturnType<typeof decodeInstallationCommand>): Promise<void> {
    try {
      if (command.type === "kill" && handle === undefined) cancel();
      const process = await preparing;
      let value: unknown;
      const transfer: Transferable[] = [];
      switch (command.type) {
        case "stdio":
          value = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
          transfer.push(process.stdin, process.stdout, process.stderr);
          break;
        case "exit": value = await process.exit; break;
        case "generation": value = await process.generation; break;
        case "kill": await process.kill(command.signal); break;
      }
      if (!closed) port.postMessage({ version: PROTOCOL_VERSION, id: command.id, ok: true, value }, transfer);
    } catch (error) {
      if (!closed) {
        try { port.postMessage({ version: PROTOCOL_VERSION, id: command.id, ok: false, error: serializeUnknownError(error) }); }
        catch (failure) { failed(failure); }
      }
    } finally {
      active.delete(command.type); delivered.add(command.type);
      if (active.size === 0 && ["stdio", "exit", "generation"].every(type => delivered.has(type))) close();
    }
  }
  port.addEventListener("message", receive);
  port.addEventListener("messageerror", messageError);
  port.start();
  return () => failed(new VMError("ABORTED", "Installation channel retired"));
}
