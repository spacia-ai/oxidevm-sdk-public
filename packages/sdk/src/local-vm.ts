import { typescriptInterceptor } from "./typescript-interceptor.js";
import { commandAccelerationSupport, NATIVE_EXECUTION_ABSENT_WARNING, openNativeExecution, type NativeExecutionOpen } from "./native-execution.js";
import type { LicenseStatus, VM } from "./contracts.js";
import { admitLicense } from "./license-admission.js";
import { defineImage, imagePublicKeyBytes } from "./image.js";
import { resolveProcessLimit } from "./vm-options.js";
import type { ValidatedVMOptions } from "./vm-options.js";
import { loadEngineAssets, requireEngineUrl, abortIfRequested } from "./engine-assets.js";
import { defaultImage } from "./default-image.js";
import { inspectRetainedStart } from "./retained-start.js";
import { verifyImage } from "./verified-image.js";
import { adaptVM, toBootProgress } from "./vm-adapter.js";
import { createUserspaceRuntimeVM } from "./runtime/userspace-vm.js";
import { createSystemRuntimeVM } from "./runtime/system-vm.js";
import type { RuntimeVM } from "./runtime/vm-types.js";
import type { PreviewKeeperHost } from "./runtime/preview-keeper.js";
import { VMError, withCleanupFailure } from "./runtime/errors.js";

/** What the runtime frame changes about a local VM: where preview keepers live. */
export interface LocalVMHosting {
  readonly previewKeeperHost?: PreviewKeeperHost;
  /** The page that embeds the runtime frame; a self-hosted VM is its own embedder. */
  readonly embedderOrigin?: string;
}

/** Creates the VM in this page, from the engine release at `baseUrl`. The runtime frame runs this too. */
export async function createLocalVM(options: ValidatedVMOptions, baseUrl: string, hosting: LocalVMHosting = {}): Promise<VM> {
  abortIfRequested(options.signal);
  if (typeof Worker !== "function" || typeof globalThis.location !== "object") throw new VMError("FEATURE_NOT_AVAILABLE", "VM creation requires a browser with module workers", { reason: "browser-unsupported" });
  if (options.mode === "system" && options.vcpus !== 1) throw new VMError("FEATURE_NOT_AVAILABLE", "this SDK release qualifies one System vCPU", { reason: "release-gate-open" });
  const requestedImage = options.image ?? defaultImage(options.mode);
  const [inspection, loading] = await Promise.allSettled([
    inspectRetainedStart(options, requestedImage, location.href),
    loadEngineAssets(options.mode, new URL(baseUrl, location.href).href, options.signal, options.onProgress),
  ]);
  if (inspection.status === "rejected") { if (loading.status === "fulfilled") loading.value.dispose(); const failure: unknown = inspection.reason; throw failure; }
  if (loading.status === "rejected") { const failure: unknown = loading.reason; throw failure; }
  const retained = inspection.value, assets = loading.value;
  const image = retained === null ? requestedImage : defineImage({mode:options.mode,manifestUrl:retained.manifestUrl,manifestSHA256:retained.image.manifestSHA256,trust:requestedImage.trust});
  const verified = await (retained === null ? verifyImage(image, location.href, options.signal, options.onProgress) : Promise.resolve({info:retained.image,memoryMiB:retained.memoryMiB,...(retained.maxProcesses===undefined?{}:{maxProcesses:retained.maxProcesses})})).catch((error: unknown) => { assets.dispose(); throw error; });
  // The engine admits this use before anything runs (ADR 0021); a refusal stops here.
  let license: LicenseStatus;
  let userspaceWasmModule: WebAssembly.Module | undefined;
  try {
    const engine = requireEngineUrl(assets, options.mode === "system" ? "oxidevm_core.wasm" : "oxidevm_userspace.wasm");
    if (options.mode === "userspace") userspaceWasmModule = await assets.compile("oxidevm_userspace.wasm");
    license = await admitLicense(userspaceWasmModule ?? engine, {
      runtimeOrigin: location.origin, embedderOrigin: hosting.embedderOrigin ?? location.origin,
      ...(options.runtime.license === undefined ? {} : { token: options.runtime.license }), nowSeconds: Date.now() / 1000,
    });
  } catch (error) { assets.dispose(); throw error; }
  let runtime: RuntimeVM | undefined;
  let nativeExecution: NativeExecutionOpen | undefined;
  try {
    abortIfRequested(options.signal);
    const native = options.mode === "userspace" && options.acceleration === "auto" ? await openNativeExecution(baseUrl, options.signal) : undefined;
    if (native?.status === "open") nativeExecution = native;
    if (native?.status === "absent") console.warn(NATIVE_EXECUTION_ABSENT_WARNING);
    const commandAcceleration = commandAccelerationSupport(options.mode === "system" ? "not-applicable" : options.acceleration, native);
    const common = {
      workspaceId: options.workspaceId, ephemeral: options.ephemeral, memoryMiB: options.memoryMiB ?? verified.memoryMiB,
      // Every boot first revokes relay access, so the runtime starts local and relay options
      // connect through the VM's own network owner below, once the VM is ready.
      network: "local" as const,
      ...(options.preview === undefined ? {} : { previewOrigin: String(options.preview.origin), previewIsolation: options.preview.isolation }),
      ...(hosting.previewKeeperHost === undefined ? {} : { previewKeeperHost: hosting.previewKeeperHost }),
    };
    runtime = options.mode === "system" ? await createSystemRuntimeVM({ ...common, mode: "system", vcpus: options.vcpus,
      coreWasmUrl: requireEngineUrl(assets, "oxidevm_core.wasm"), sharedCoreWasmUrl: requireEngineUrl(assets, "oxidevm_core_shared.wasm"), netstackWasmUrl: requireEngineUrl(assets, "oxidevm_netstack.wasm") })
      : await createUserspaceRuntimeVM({ ...common, mode: "userspace", limits: { maxProcesses: resolveProcessLimit(options, verified.maxProcesses) },
        ...(nativeExecution === undefined ? {} : { nativeExecutionPort: nativeExecution.port }),
        ...(options.acceleration === "off" || options.interceptors === false || options.interceptors === undefined && !globalThis.crossOriginIsolated ? {} : { interceptors: options.interceptors ?? [{ command: "tsc", worker: typescriptInterceptor().worker.href }] }),
        ...(options.initialUser === undefined ? {} : { initialUser: options.initialUser }), ...(options.rootPersistence === undefined ? {} : { rootPersistence: options.rootPersistence }),
        ...(userspaceWasmModule === undefined ? {} : { userspaceWasmModule }),
        userspaceWasmUrl: requireEngineUrl(assets, "oxidevm_userspace.wasm"), userspaceSharedWasmUrl: requireEngineUrl(assets, "oxidevm_userspace.wasm") });
    if (nativeExecution !== undefined) {
      const disposeRuntime = runtime.dispose.bind(runtime), execution = nativeExecution;
      runtime.dispose = async () => { try { await disposeRuntime(); } finally { execution.dispose(); } };
    }
    abortIfRequested(options.signal);
    const booted = await runtime.bootManagedImage(image.manifestUrl, {
      trustedKeyId: image.trust.keyId, trustedPublicKey: imagePublicKeyBytes(image.trust), manifestSHA256: image.manifestSHA256,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      resume: options.resume,
      imagePreparation: options.imagePreparation,
      ...(options.shipped===undefined?{}:{shipped:options.shipped}),
      ...(retained===null?{}:{cachedOnly:true}),
      onProgress: progress => options.onProgress?.(toBootProgress(options.mode, progress)),
    });
    const actual=booted.identity??verified.info;
    if(actual.mode!==options.mode||actual.id!==booted.id||actual.version!==booted.version) throw new VMError("PROTOCOL_ERROR","runtime did not supply the verified identity of its actual image");
    // This enters the existing Rust VFS owner and forces Userspace mount before ready.
    await runtime.workspace.entries("/", options.signal);
    abortIfRequested(options.signal);
    const vm = await adaptVM(runtime, options, actual, assets, license, commandAcceleration, {...booted,...(booted.update!==undefined||retained?.update===undefined?{}:{update:retained.update})});
    if (options.network.mode === "relay") await vm.network.connect(options.network.connection, options.signal === undefined ? {} : { signal: options.signal });
    options.onProgress?.({ phase: "ready" }); return vm;
  } catch (error) {
    nativeExecution?.dispose();
    try { await runtime?.dispose(); }
    catch (cleanupError: unknown) { throw withCleanupFailure(error, cleanupError); }
    finally { assets.dispose(); }
    throw error;
  }
}
