import { WorkerClient } from "./worker-client.js";
import { controlResponseDecoders, type ControlOperations, type PreparedUserspaceRootfs } from "./protocol.js";
import { ScriptedWorker } from "./system-vm.test-support.js";

export const NATIVE_MANIFEST = "https://example.test/rootfs.json";
export const NATIVE_TRUST = { trustedKeyId: "test", trustedPublicKey: new Uint8Array(32) };
export const NATIVE_ROOTFS: PreparedUserspaceRootfs = { id: "alpine", version: "v1", rootTreeSha256: "a".repeat(64), cpuProfile: "x86-64-v2",
  fileCount: 1, totalBytes: 1, metadata: new Uint8Array(4), runtimes: { node: "usr/bin/node", bun: "usr/bin/bun", supportingFiles: [] } };

export function nativeStartup(): void {
  ScriptedWorker.answers.set("prepare-userspace-rootfs", () => NATIVE_ROOTFS);
  ScriptedWorker.answers.set("current-userspace-image", () => ({ id: "alpine", version: "v1", mode: "userspace", cpuProfile: "x86-64-v2", manifestSHA256: "a".repeat(64), keyId: "test", signatureVerified: true }));
  ScriptedWorker.answers.set("current-userspace-rootfs", () => NATIVE_ROOTFS);
  ScriptedWorker.answers.set("select-userspace-files", () => ({sourceId:"123e4567-e89b-42d3-a456-426614174001"}));
  ScriptedWorker.answers.set("start-userspace-cold", () => ({state:"in-sync",conflicts:[],omittedConflicts:0}));
  ScriptedWorker.answers.set("configure-userspace-checkpoints", () => undefined);
  ScriptedWorker.answers.set("flush-userspace", () => undefined);
}

export async function bootedNativeVm(workspaceId = "userspace") {
  nativeStartup();
  const { createRuntimeVM } = await import("./index.js");
  const vm = await createRuntimeVM({ mode: "userspace", workspaceId, memoryMiB: 256, network: "local" });
  await vm.bootManagedImage(NATIVE_MANIFEST, NATIVE_TRUST);
  return vm;
}

/** Exercise the common control boundary while individual tests replace native execution. */
export function nativeBackend() {
  const control = new WorkerClient<ControlOperations>(new Worker("", { name: "oxidevm-control" }), controlResponseDecoders);
  return { control, revokeNetwork: () => Promise.resolve(), dispose: () => { control.terminate(); return Promise.resolve(); },
    attachProcess: () => Promise.reject(new Error("Process attachment not configured by this fixture")) };
}
