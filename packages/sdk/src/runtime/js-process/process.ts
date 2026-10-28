import type { LinuxProcessInfo, LinuxProcesses, NativeChildSpec } from "../../js-process-types.js";
import { decodeProcessId } from "../../values.js";
import { type LinuxResult, descriptor, noValue, operation, protocol, Reader, Writer } from "./codec.js";
import { knownLinuxSignal } from "../process-signals.js";
import type { LinuxClient } from "./transport.js";

export function umaskOperation(mask?: number) {
  const payload = new Writer().u8(mask === undefined ? 0 : 1);
  if (mask !== undefined) payload.u32(mask);
  return operation(65547, payload, result => {
    if (result.bytes.byteLength !== 0 || result.value < 0n || result.value > 0o777n) protocol("Invalid Linux umask result");
    return Number(result.value);
  });
}

export function searchPathOperation(filename: string, path: string) {
  const bytes = new TextEncoder().encode(path);
  if (filename.length === 0 || bytes.byteLength > 1024 * 1024 || bytes.includes(0)) protocol("Invalid bounded PATH lookup");
  return operation(65548, new Writer().path(filename).blob(bytes), result => {
    if (result.bytes.byteLength === 0 || result.bytes.byteLength > 4095 || result.value !== BigInt(result.bytes.byteLength) || result.bytes.includes(0)) protocol("Invalid PATH lookup result");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); }
    catch { return protocol("Invalid UTF-8 in PATH lookup result"); }
  });
}

type SpawnInvocation = { readonly kind: "search" | "selected"; readonly argv0: string };
export function spawnPayload(spec: NativeChildSpec, ipc = false, invocation?: SpawnInvocation): Writer {
  const writer = new Writer().path(spec.command).strings(spec.args ?? []);
  if (spec.env === undefined) writer.u8(0);
  else writer.u8(1).strings(Object.entries(spec.env).map(([key, value]) => {
    if (key === "" || key.includes("=") || key.includes("\0")) protocol("Invalid native child environment name"); return `${key}=${value}`;
  }));
  if (spec.cwd === undefined) writer.u8(0); else writer.u8(1).path(spec.cwd);
  writer.u8((spec.stdio?.stdin === "pipe" ? 1 : 0) | (spec.stdio?.stdout === "pipe" ? 2 : 0) | (spec.stdio?.stderr === "pipe" ? 4 : 0) | (ipc ? 8 : 0)
    | (invocation === undefined ? 0 : 16) | (invocation?.kind === "selected" ? 32 : 0));
  if (invocation !== undefined) writer.path(invocation.argv0);
  return writer;
}
export function process(client: LinuxClient): LinuxProcesses {
  return {
    info: () => client.call(operation(65537, new Writer(), result => decodeInfo(result.bytes))),
    cwd: () => client.call(operation(79, new Writer(), result => { if (result.bytes.at(-1) !== 0 || result.value !== BigInt(result.bytes.byteLength)) protocol("Invalid Linux cwd result"); return new TextDecoder().decode(result.bytes.subarray(0, -1)); })),
    chdir: path => client.call(operation(80, new Writer().path(path), noValue)),
    spawn: (spec, options) => client.call(operation(65538, spawnPayload(spec), decodeSpawn), options?.signal),
    wait: (pid, options) => client.call(operation(61, new Writer().u32(pid), result => {
      if (result.bytes.byteLength !== 0 || result.value > 0xffffn) protocol("Invalid native child exit status");
      const status = Number(result.value), signal = status & 0x7f;
      return signal === 0 ? { kind: "exited", code: status >> 8 } : { kind: "signaled", signal: knownLinuxSignal(signal), signalNumber: signal };
    }), options?.signal),
    signal: (pid, signal) => client.call(operation(62, new Writer().u32(pid).u8(signal), noValue)),
  };
}
function decodeInfo(bytes: Uint8Array): LinuxProcessInfo {
  const r = new Reader(bytes), pid = decodeProcessId(r.u32()), parent = r.u32(), uid = r.u32(), gid = r.u32(), columns = r.u16(), rows = r.u16();
  if ((columns === 0) !== (rows === 0)) protocol("Invalid Linux terminal dimensions");
  const cwd = r.text(4095), args = r.strings(), environment = r.strings(); r.end();
  return { pid, parentPid: parent === 0 ? null : decodeProcessId(parent), uid, gid, cwd, args, environment, terminal: columns === 0 ? null : { columns, rows } };
}

export function decodeSpawn(result: LinuxResult) {
  if (result.bytes.byteLength !== 12) protocol("Invalid native child result");
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  const fd = (offset: number) => { const value = view.getInt32(offset, true); return value === -1 ? null : descriptor(value); };
  return { pid: decodeProcessId(Number(result.value)), stdin: fd(0), stdout: fd(4), stderr: fd(8) };
}
