import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { PROTOCOL_VERSION } from "./common.js";
import { decodeUndefined } from "./decoders.js";

export interface InstallationStdio {
  readonly stdin: WritableStream<unknown>;
  readonly stdout: ReadableStream<unknown>;
  readonly stderr: ReadableStream<unknown>;
}
export interface InstallationExit { readonly code: number | null; readonly signal?: string }
export type InstallationSignal = "TERM" | "KILL" | "INT" | "HUP";
export interface DependencyInstallationOperations {
  readonly stdio: { readonly request: undefined; readonly response: InstallationStdio };
  readonly exit: { readonly request: undefined; readonly response: InstallationExit };
  readonly generation: { readonly request: undefined; readonly response: string };
  readonly kill: { readonly request: { readonly signal: InstallationSignal }; readonly response: undefined };
}
export function installationSignal(value: unknown): InstallationSignal {
  if (value !== "TERM" && value !== "KILL" && value !== "INT" && value !== "HUP") throw new VMError("PROTOCOL_ERROR", "Invalid installation signal");
  return value;
}
export function decodeInstallationCommand(value: unknown) {
  const input = record(value, "installation command");
  integer(input["version"], "installation version", PROTOCOL_VERSION, PROTOCOL_VERSION);
  const id = integer(input["id"], "installation request", 1);
  const type = input["type"];
  if (type === "kill") {
    exactKeys(input, ["id", "version", "type", "signal"]);
    return { id, type, signal: installationSignal(input["signal"]) };
  }
  if (type !== "stdio" && type !== "exit" && type !== "generation") throw new VMError("PROTOCOL_ERROR", "Invalid installation command");
  exactKeys(input, ["id", "version", "type"]);
  return { id, type };
}
export const installationResponseDecoders = {
  stdio(value: unknown): InstallationStdio {
    const input = record(value, "installation stdio");
    exactKeys(input, ["stdin", "stdout", "stderr"]);
    if (!(input["stdin"] instanceof WritableStream) || !(input["stdout"] instanceof ReadableStream) || !(input["stderr"] instanceof ReadableStream)) {
      throw new VMError("PROTOCOL_ERROR", "Invalid installation streams");
    }
    if (input["stdin"].locked || input["stdout"].locked || input["stderr"].locked || input["stdout"] === input["stderr"]) {
      throw new VMError("PROTOCOL_ERROR", "Installation streams are not independently transferable");
    }
    return { stdin: input["stdin"], stdout: input["stdout"], stderr: input["stderr"] };
  },
  exit(value: unknown): InstallationExit {
    const input = record(value, "installation exit");
    exactKeys(input, ["code"], ["signal"]);
    const code = input["code"] === null ? null : integer(input["code"], "installation exit code", 0, 255);
    if (input["signal"] === undefined) {
      if (code === null) throw new VMError("PROTOCOL_ERROR", "Missing installation exit status");
      return { code };
    }
    const signal = string(input["signal"], "installation exit signal");
    if (code !== null || !/^SIG[A-Z0-9]+$/.test(signal) || signal.length > 32) throw new VMError("PROTOCOL_ERROR", "Invalid installation exit signal");
    return { code, signal };
  },
  generation(value: unknown): string {
    const digest = string(value, "dependency generation");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new VMError("PROTOCOL_ERROR", "Invalid dependency generation");
    return digest;
  },
  kill: decodeUndefined,
};
