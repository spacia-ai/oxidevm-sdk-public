import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceOperation, readAssistanceEnvironment, writeAssistanceEnvironment } from "./assistance.js";

/** Internal fork codec shared by the process mailbox, the broker and control.
 * A parent runtime describes the child it wants; control allocates the child's
 * identity and issues the guest Fork, so no worker ever names a task. */
export interface ForkRequest {
  readonly entry: string;
  readonly args: readonly string[];
  readonly execArgv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly silent: boolean;
}
export type ForkReply =
  | { readonly kind: "spawned"; readonly process: number; readonly pid: number }
  | { readonly kind: "error"; readonly errno: number; readonly code: string };

/** The only Node execution arguments the assisted runtime implements. */
export const FORK_EXEC_ARGUMENTS: readonly string[] = ["--enable-source-maps", "--no-enable-source-maps"];

/** The only Node execution arguments a forked child may carry, each at most
 * once. Every boundary that receives execArgv validates it here. */
export function decodeForkExecArgv(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > FORK_EXEC_ARGUMENTS.length) fail("Unsupported fork execArgv");
  const arguments_ = value.map((argument: unknown) => {
    if (typeof argument !== "string" || !FORK_EXEC_ARGUMENTS.includes(argument)) fail("Unsupported fork execArgv");
    return argument;
  });
  if (new Set(arguments_).size !== arguments_.length) fail("Duplicate fork execArgv");
  return arguments_;
}
const REQUEST_TAG = 1;
const REPLY_TAG = 2;

function fail(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }

export function decodeForkRequest(value: unknown): ForkRequest {
  const input = record(value, "fork request");
  exactKeys(input, ["entry", "args", "execArgv", "cwd", "env", "silent"]);
  // The child's entry, arguments and environment obey the native spawn bounds.
  const spawn = decodeAssistanceOperation({ kind: "spawn", command: input["entry"], args: input["args"], cwd: input["cwd"], env: input["env"] });
  if (spawn.kind !== "spawn" || !spawn.command.startsWith("/") || !spawn.cwd.startsWith("/")) fail("Fork requires resolved guest paths");
  const arguments_ = decodeForkExecArgv(input["execArgv"]);
  return { entry: spawn.command, args: spawn.args, execArgv: arguments_, cwd: spawn.cwd, env: spawn.env, silent: boolean(input["silent"], "fork silent flag") };
}

export function encodeForkRequest(value: unknown): Uint8Array<ArrayBuffer> {
  const request = decodeForkRequest(value);
  const output = new AgentPayloadWriter(ASSISTANCE_LIMITS.request);
  output.u8(REQUEST_TAG).string(request.entry).u32(request.args.length);
  for (const argument of request.args) output.string(argument);
  output.u32(request.execArgv.length);
  for (const argument of request.execArgv) output.string(argument);
  output.string(request.cwd);
  writeAssistanceEnvironment(output, request.env);
  output.u8(request.silent ? 1 : 0);
  return output.finish();
}

export function decodeForkRequestBytes(bytes: Uint8Array): ForkRequest {
  const input = new AgentPayloadReader(bytes);
  if (input.u8() !== REQUEST_TAG) fail("Invalid fork request tag");
  const entry = input.string();
  const args = Array.from({ length: integer(input.u32(), "fork argument count", 0, 4096) }, () => input.string());
  const execArgv = Array.from({ length: integer(input.u32(), "fork execArgv count", 0, FORK_EXEC_ARGUMENTS.length) }, () => input.string());
  const cwd = input.string();
  const env = readAssistanceEnvironment(input);
  const silent = input.u8();
  if (silent > 1) fail("Invalid fork silent flag");
  input.finish();
  return decodeForkRequest({ entry, args, execArgv, cwd, env, silent: silent === 1 });
}

export function decodeForkReply(value: unknown): ForkReply {
  const input = record(value, "fork reply");
  switch (input["kind"]) {
    case "spawned":
      exactKeys(input, ["kind", "process", "pid"]);
      return { kind: "spawned", process: integer(input["process"], "fork child process", 1, 0xffff_ffff), pid: integer(input["pid"], "fork child pid", 2, 0x7fff_ffff) };
    case "error": {
      exactKeys(input, ["kind", "errno", "code"]);
      const code = string(input["code"], "fork error code");
      if (!/^E[A-Z0-9]{1,15}$/u.test(code)) fail("Invalid fork error code");
      return { kind: "error", errno: integer(input["errno"], "fork errno", 1, 4095), code };
    }
    default: return fail("Unknown fork reply");
  }
}

export function encodeForkReply(value: unknown): Uint8Array<ArrayBuffer> {
  const reply = decodeForkReply(value);
  const output = new AgentPayloadWriter(ASSISTANCE_LIMITS.request).u8(REPLY_TAG);
  if (reply.kind === "spawned") output.u8(0).u32(reply.process).u32(reply.pid);
  else output.u8(1).u32(reply.errno).string(reply.code);
  return output.finish();
}

export function decodeForkReplyBytes(bytes: Uint8Array): ForkReply {
  const input = new AgentPayloadReader(bytes);
  if (input.u8() !== REPLY_TAG) fail("Invalid fork reply tag");
  const outcome = input.u8();
  const reply: unknown = outcome === 0 ? { kind: "spawned", process: input.u32(), pid: input.u32() }
    : outcome === 1 ? { kind: "error", errno: input.u32(), code: input.string() } : fail("Invalid fork reply outcome");
  input.finish();
  return decodeForkReply(reply);
}
