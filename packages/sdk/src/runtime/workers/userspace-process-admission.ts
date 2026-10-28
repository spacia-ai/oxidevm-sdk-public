import { VMError } from "../errors.js";
import { decodeUserspaceSpawnResult, encodeUserspaceArguments } from "../userspace-abi.js";
import { assertUserspaceStatus, callUserspaceU32 as call } from "./userspace-exports.js";
import { readFileRecord } from "./userspace-files.js";

export type InitialUserspaceProgram =
  | { readonly kind: "elf"; readonly bytes: Uint8Array }
  | { readonly kind: "file"; readonly filename: string };

type InitialProcessInput = {
  readonly arguments: readonly string[];
  readonly environment: readonly string[];
  readonly cwd: string;
  readonly terminal?: { readonly columns: number; readonly rows: number };
};

type AdmissionRuntime = {
  readonly instance: WebAssembly.Instance;
  readonly memory: WebAssembly.Memory;
};

function spawnError(errno: number): VMError {
  const code = errno === 1 || errno === 13 ? "PERMISSION_DENIED"
    : errno === 11 || errno === 12 ? "QUOTA_EXCEEDED"
      : errno === 38 || errno === 95 ? "FEATURE_NOT_AVAILABLE" : "INVALID_ARGUMENT";
  return new VMError(code, "Userspace executable admission failed", { errno });
}

/** Only immutable rootfs reads may suspend admission before Rust publishes a PID. */
export async function admitInitialUserspaceProcess(
  runtime: AdmissionRuntime,
  program: InitialUserspaceProgram,
  input: InitialProcessInput,
  checkCanceled: () => void,
  serviceNextRead: () => Promise<boolean>,
): Promise<number> {
  const source = program.kind === "elf" ? program.bytes : new TextEncoder().encode(program.filename);
  const arguments_ = encodeUserspaceArguments(input.arguments);
  const environment = encodeUserspaceArguments(input.environment);
  const cwd = new TextEncoder().encode(input.cwd);
  const length = source.byteLength + arguments_.byteLength + environment.byteLength + cwd.byteLength;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    checkCanceled();
    assertUserspaceStatus(call(runtime.instance, "oxidevm_userspace_staging_resize", length), "resize process staging");
    const staging = new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), length);
    let offset = 0;
    for (const bytes of [source, arguments_, environment, cwd]) { staging.set(bytes, offset); offset += bytes.byteLength; }
    const status = call(runtime.instance, program.kind === "elf"
      ? "oxidevm_userspace_spawn_top_level_process" : "oxidevm_userspace_spawn_top_level_executable",
    source.byteLength, arguments_.byteLength, environment.byteLength, cwd.byteLength,
    input.terminal?.columns ?? 0, input.terminal?.rows ?? 0);
    if (program.kind === "elf") {
      if (status > 0x7fff_ffff) throw new VMError("PROTOCOL_ERROR", "Userspace spawn returned an invalid PID");
      if (status !== 0) return status;
    } else if (status !== 3) {
      assertUserspaceStatus(status, "file process admission");
      const result = decodeUserspaceSpawnResult(readFileRecord(runtime));
      if (result.kind === "spawned") return result.pid;
      throw spawnError(result.errno);
    }
    if (!await serviceNextRead()) {
      if (program.kind === "file") throw new VMError("PROTOCOL_ERROR", "native executable read has no host request");
      throw new VMError("INVALID_ARGUMENT", "Userspace process could not be spawned");
    }
    checkCanceled();
  }
  throw new VMError("GUEST_CRASH", "native executable admission exceeded its host-read bound");
}
