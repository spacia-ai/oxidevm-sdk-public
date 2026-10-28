import type { NetworkOptions, RuntimeAssets, RuntimeOptions } from "./contracts.js";
import { VMError, withCleanupFailure } from "./runtime/errors.js";
import { exactKeys, integer, record, string } from "./runtime/decode.js";
import { validateSystemBootInput } from "./runtime/protocol.js";
import { createSystemRuntimeVM } from "./runtime/system-vm.js";
import { loadEngineAssets, requireEngineUrl, abortIfRequested } from "./engine-assets.js";
import { DEFAULT_SELF_HOSTED_BASE_URL, decodePublicVMOptions } from "./vm-options.js";
import type { RuntimeVM } from "./runtime/vm-types.js";

export interface SystemBootSpec {
  readonly kernel: Uint8Array;
  readonly initrd?: Uint8Array;
  readonly disk?: Uint8Array;
  readonly commandLine: string;
}
export interface RawMachineOptions {
  readonly mode: "system";
  readonly boot: SystemBootSpec;
  readonly memoryMiB: number;
  readonly vcpus?: 1 | 2 | 3 | 4;
  readonly runtime?: RuntimeAssets | Extract<RuntimeOptions, { readonly hosting: "self-hosted" }>;
  readonly network?: NetworkOptions;
  readonly console?: "serial" | "virtio";
  readonly signal?: AbortSignal;
}
export interface RawMachine {
  readonly mode: "system";
  readonly console: { readonly input: WritableStream<Uint8Array>; readonly output: ReadableStream<Uint8Array> };
  pause(): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
}

export async function bootMachine(input: RawMachineOptions): Promise<RawMachine> {
  const decoded = decodeOptions(input);
  // Raw machines are a diagnostic of this page's own engine copy; they never run in the frame.
  const common = decodePublicVMOptions({ mode: "system", ...(input.vcpus === undefined ? {} : { vcpus: input.vcpus }), runtime: input.runtime ?? { hosting: "self-hosted", baseUrl: DEFAULT_SELF_HOSTED_BASE_URL }, ...(input.network === undefined ? {} : { network: input.network }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
  abortIfRequested(common.signal);
  if (typeof Worker !== "function" || typeof globalThis.location !== "object") throw new VMError("FEATURE_NOT_AVAILABLE", "raw machine creation requires browser module workers", { reason: "browser-unsupported" });
  if (common.mode !== "system" || common.vcpus !== 1) throw new VMError("FEATURE_NOT_AVAILABLE", "raw vCPU count is not qualified for this SDK release", { reason: "release-gate-open" });
  if (common.runtime.hosting !== "self-hosted") throw new VMError("FEATURE_NOT_AVAILABLE", "raw machines run only with a self-hosted runtime", { reason: "mode-unsupported" });
  const assets = await loadEngineAssets("system", new URL(common.runtime.baseUrl, location.href).href, common.signal);
  let runtime: RuntimeVM | undefined;
  try {
    runtime = await createSystemRuntimeVM({ mode: "system", workspaceId: common.workspaceId, ephemeral: true, memoryMiB: decoded.memoryMiB, vcpus: common.vcpus,
      network: "local",
      coreWasmUrl: requireEngineUrl(assets, "oxidevm_core.wasm"), sharedCoreWasmUrl: requireEngineUrl(assets, "oxidevm_core_shared.wasm"), netstackWasmUrl: requireEngineUrl(assets, "oxidevm_netstack.wasm") });
    await runtime.diagnostics.bootSystem(decoded.boot, { console: decoded.console, ...(common.signal === undefined ? {} : { signal: common.signal }) });
    // Booting revokes relay access first. Relay options connect the machine's own network owner
    // after configuration and before execution, so the guest has its link from the start.
    if (common.network.mode === "relay") await runtime.network.connect(common.network.connection, common.signal === undefined ? {} : { signal: common.signal });
    const execution = await runtime.diagnostics.startSystem();
    void execution.exit.catch(() => {});
    const reader = execution.events.getReader();
    const output = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) { controller.close(); reader.releaseLock(); return; }
            if (next.value.kind === "console") { controller.enqueue(next.value.data); return; }
          }
        } catch (error) { controller.error(error); reader.releaseLock(); }
      },
      cancel: async reason => { await reader.cancel(reason); reader.releaseLock(); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));
    const machine = runtime; let disposal: Promise<void> | undefined;
    const active = () => { if (disposal !== undefined) throw new VMError("PROTOCOL_ERROR", "raw machine has been disposed"); };
    const stdin = new WritableStream<Uint8Array>({ write: async bytes => { active(); if (!(bytes instanceof Uint8Array)) throw new VMError("INVALID_ARGUMENT", "console input must be bytes"); await machine.diagnostics.writeSystemConsole(bytes.slice()); } });
    abortIfRequested(common.signal);
    return { mode: "system", console: { input: stdin, output }, pause: () => { active(); return execution.pause(); }, resume: () => { active(); return execution.resume(); },
      dispose: () => { disposal ??= machine.dispose().finally(() => assets.dispose()); return disposal; } };
  } catch (error) {
    try { await runtime?.dispose(); }
    catch (cleanupError: unknown) { throw withCleanupFailure(error, cleanupError); }
    finally { assets.dispose(); }
    throw error;
  }
}

function decodeOptions(input: unknown): { readonly memoryMiB: number; readonly boot: SystemBootSpec; readonly console: "serial" | "virtio" } {
  try {
    const value = record(input, "raw machine options"); exactKeys(value, ["mode", "boot", "memoryMiB"], ["vcpus", "runtime", "network", "console", "signal"]);
    if (value["mode"] !== "system") throw new VMError("INVALID_ARGUMENT", "raw machine mode must be system");
    const memoryMiB = integer(value["memoryMiB"], "memoryMiB", 16, 3072);
    const source = record(value["boot"], "boot"); exactKeys(source, ["kernel", "commandLine"], ["initrd", "disk"]);
    const bytes = (value: unknown): Uint8Array<ArrayBuffer> => { if (!(value instanceof Uint8Array)) throw new VMError("INVALID_ARGUMENT", "boot artifact must be bytes"); return value.slice(); };
    const boot = { kernel: bytes(source["kernel"]), commandLine: string(source["commandLine"], "commandLine"), ...(source["initrd"] === undefined ? {} : { initrd: bytes(source["initrd"]) }), ...(source["disk"] === undefined ? {} : { disk: bytes(source["disk"]) }) };
    validateSystemBootInput(memoryMiB, boot.kernel.byteLength, boot.initrd?.byteLength ?? 0, boot.disk?.byteLength ?? 0, boot.commandLine);
    const console = value["console"] ?? "serial";
    if (console !== "serial" && console !== "virtio") throw new VMError("INVALID_ARGUMENT", "raw console must be serial or virtio");
    return { memoryMiB, boot, console };
  } catch (error) { if (error instanceof VMError && error.code === "PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT", error.message); throw error; }
}
