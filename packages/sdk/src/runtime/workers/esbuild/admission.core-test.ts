import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { instantiateRuntime } from "../userspace-runtime.js";
import { admitJSProcess } from "../js-process/admission.js";
import { callUserspaceU32 as call } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { encodeFilesystemRecord } from "../../userspace-rootfs-record.js";
import { decodeUserspaceHostRequest } from "../../userspace-abi.js";
import { encodeJSRequest, decodeJSCompletion } from "../../js-process/native-abi.js";
import { spawnPayload } from "../../js-process/process.js";
import { engineModulePath } from "../engine-wasm.test-support.js";

const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve("esbuild"));
const binary = new Uint8Array(await readFile(esbuild.resolve("@esbuild/linux-x64/bin/esbuild")));
const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))));
const forms = [
  { name: "service", args: ["--service=0.25.12"], admitted: true },
  { name: "ping service", args: ["--service=0.25.12", "--ping"], admitted: true },
  { name: "renamed executable", path: "/workspace/renamed", args: ["--service=0.25.12"], admitted: true },
  { name: "disabled acceleration", args: ["--service=0.25.12"], disabled: true, admitted: false },
  { name: "different version", args: ["--service=0.25.11"], admitted: false },
  { name: "CLI invocation", args: ["--bundle"], admitted: false },
  { name: "extra service flag", args: ["--service=0.25.12", "--ping", "--bundle"], admitted: false },
  { name: "modified executable", args: ["--service=0.25.12"], modified: true, admitted: false },
  { name: "unqualified Go debug mode", args: ["--service=0.25.12"], env: { GODEBUG: "gctrace=1" }, admitted: false },
];

it.each(forms)("qualifies the authenticated $name through the ordinary native-child boundary", async settings => {
  const payload = binary.slice();
  if (settings.modified === true) payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 1;
  const executable = settings.path ?? "/workspace/esbuild";
  const rootfs = encodeFilesystemRecord([{ tag: 1, mode: 0o755, path: new TextEncoder().encode(executable), pathText: executable, payload }], "rootfs");
  const runtime = await instantiateRuntime(module, "esbuild-admission", { kind: "disabled" });
  function stage(bytes: Uint8Array): void {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.length)).toBe(0);
    new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.length).set(bytes);
  }
  function launch() {
    expect(call(runtime.instance, "oxidevm_userspace_host_request_next", 8)).toBe(0);
    const length = call(runtime.instance, "oxidevm_userspace_host_request_len"), pointer = call(runtime.instance, "oxidevm_userspace_host_request_ptr");
    return length === 0 ? undefined : decodeUserspaceHostRequest(new Uint8Array(runtime.memory.buffer, pointer, length).slice());
  }
  try {
    stage(rootfs); expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", rootfs.length, 1, 256)).toBe(0);
    if (settings.disabled !== true) expect(call(runtime.instance, "oxidevm_userspace_acceleration_enable")).toBe(0);
    admitJSProcess(runtime, 1, [], [], "/workspace");
    const parent = launch();
    if (parent?.kind !== "command") throw new Error("Missing JS parent");
    const request = encodeJSRequest(parent, 1, 65538, spawnPayload({ command: executable, args: settings.args, ...(settings.env === undefined ? {} : { env: settings.env }) }).finish());
    stage(request); expect(call(runtime.instance, "oxidevm_userspace_js_submit", request.length)).toBe(0);
    expect(new DataView(readFileRecord(runtime).buffer).getUint32(0, true)).toBe(0);
    expect(call(runtime.instance, "oxidevm_userspace_js_next")).toBe(0);
    expect(decodeJSCompletion(readFileRecord(runtime)).errno).toBe(0);
    const child = launch();
    if (settings.admitted) expect(child).toMatchObject({ kind: "command", program: { kind: "esbuild", executable, version: "0.25.12" }, args: [executable, ...settings.args] });
    else expect(child).toBeUndefined();
  } finally { await runtime.jitRuntime.dispose(); }
});
