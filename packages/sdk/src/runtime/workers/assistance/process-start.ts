import { exactKeys, integer, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeBrokerCommand } from "../../protocol/assistance-broker.js";
import { decodeMailbox } from "./mailbox.js";

/** A fork child's bootstrap also carries its private IPC port; a child with a
 * parent but no port, or a port without a parent, is a broker defect. */
export function decodeProcessStart(value: unknown) {
  const input = record(value, "process worker startup");
  exactKeys(input, ["kind", "identity", "entry", "cwd", "args", "env", "buffer", "compilerModule", "nextCompilerModule", "httpParserModule"], ["trafficBytes", "dependencies", "parent", "silent", "execArgv", "ipc"]);
  const { buffer, compilerModule, nextCompilerModule, httpParserModule, trafficBytes, ipc, ...command } = input;
  const start = decodeBrokerCommand(command);
  if (start.kind !== "start" || !(compilerModule instanceof WebAssembly.Module) || !(nextCompilerModule instanceof WebAssembly.Module) || !(httpParserModule instanceof WebAssembly.Module)) {
    throw new VMError("PROTOCOL_ERROR", "Invalid process worker bootstrap");
  }
  if ((start.parent === undefined) !== (ipc === undefined) || (ipc !== undefined && !(ipc instanceof MessagePort))) {
    throw new VMError("PROTOCOL_ERROR", "A fork child bootstrap needs exactly one parent and one IPC port");
  }
  return { ...start, buffer: decodeMailbox(buffer), compilerModule, nextCompilerModule, httpParserModule,
    ...(trafficBytes === undefined ? {} : { trafficBytes: integer(trafficBytes, "process transport window", 256 * 1024, 1024 * 1024) }),
    ...(ipc === undefined ? {} : { ipc }) };
}
