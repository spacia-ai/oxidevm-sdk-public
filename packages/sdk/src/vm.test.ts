import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVM, VMError } from "./index.js";
import type { UserspaceVM, RelayConnectionOptions, VMNetwork } from "./index.js";
import type * as EngineAssets from "./engine-assets.js";
import type { LoadedEngineAssets } from "./engine-assets.js";
import { relayError } from "./runtime/relay-errors.js";
import type { RuntimeVM } from "./runtime/vm-types.js";
import type { Workspace } from "./runtime/workspace.js";
import type * as NativeExecution from "./native-execution.js";
import type * as Licensing from "./license-admission.js";

vi.mock("./defaults.generated.js", async () => ({ defaultImageLocations: (await import("./default-images.test-support.js")).legacyImageLocations }));

const native = vi.hoisted(() => ({ open: vi.fn<(baseUrl: string, signal?: AbortSignal) => Promise<NativeExecution.NativeExecutionResult>>() }));
const licensing = vi.hoisted(() => ({ admit: vi.fn<typeof Licensing.admitLicense>() }));
vi.mock("./native-execution.js", async importOriginal => ({ ...(await importOriginal<typeof NativeExecution>()), openNativeExecution: native.open }));

/** The runtime members managed creation uses before and while it connects a relay. */
type FakeRuntime = Pick<RuntimeVM, "bootManagedImage" | "dispose" | "network" | "storagePersistence"> & { readonly workspace: Pick<Workspace, "entries"> };

const fake = vi.hoisted(() => {
  const state: {
    readonly events: string[];
    readonly created: unknown[];
    runtime: FakeRuntime | undefined;
    assetsDisposed: number;
    create(options: unknown): Promise<FakeRuntime>;
  } = {
    events: [], created: [], runtime: undefined, assetsDisposed: 0,
    create(options) {
      state.created.push(options);
      return state.runtime === undefined ? Promise.reject(new Error("no fake runtime")) : Promise.resolve(state.runtime);
    },
  };
  return state;
});

vi.mock("./verified-image.js", async () => {
  const { decodeSHA256 } = await import("./values.js");
  return {
    verifyImage: (image: { readonly mode: "system" | "userspace" }) => Promise.resolve({
      info: { id: "relay-test", version: "1", mode: image.mode, manifestSHA256: decodeSHA256("a".repeat(64), "test manifest"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" },
      memoryMiB: 256,
    }),
  };
});
vi.mock("./engine-assets.js", async importOriginal => ({
  ...await importOriginal<typeof EngineAssets>(),
  loadEngineAssets: (): Promise<LoadedEngineAssets> => Promise.resolve({
    urls: new Map(["oxidevm_core.wasm", "oxidevm_core_shared.wasm", "oxidevm_netstack.wasm", "oxidevm_userspace.wasm"].map(name => [name, `blob:${name}`])),
    compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))),
    dispose: () => { fake.assetsDisposed += 1; },
  }),
}));
// Admission runs the engine module, which these fakes do not have; its rules have their own tests.
vi.mock("./license-admission.js", () => ({ admitLicense: licensing.admit }));
vi.mock("./retained-start.js", () => ({ inspectRetainedStart: () => Promise.resolve(null) }));
vi.mock("./runtime/userspace-vm.js", () => ({ createUserspaceRuntimeVM: (options: unknown) => fake.create(options) }));
vi.mock("./runtime/system-vm.js", () => ({ createSystemRuntimeVM: (options: unknown) => fake.create(options) }));

it("is safe to import on the server and validates before creating browser workers", async () => {
  await expect(createVM({ mode: "userspace", limits: { maxProcesses: 0 } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(createVM({ mode: "system", signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
  await expect(createVM({ mode: "userspace" })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "browser-unsupported" } });
});

function fakeRuntime(connect: VMNetwork["connect"], dispose: () => Promise<void> = () => Promise.resolve()): FakeRuntime {
  return {
    storagePersistence: () => Promise.resolve("indexeddb"),
    bootManagedImage: () => {
      fake.events.push("boot");
      return Promise.resolve({ id: "relay-test", version: "1", runtimes: { supportingFiles: [] }, start: { kind: "booted", reason: "first-start" } });
    },
    workspace: { entries: () => { fake.events.push("mount"); return Promise.resolve([]); } },
    network: {
      state: { kind: "off" },
      connect: (options, request) => { fake.events.push("connect"); return connect(options, request); },
      disconnect: () => Promise.resolve(),
      watch: () => Promise.resolve(),
    },
    dispose: () => { fake.events.push("dispose"); return dispose(); },
  };
}

describe("creation-time relay networking", () => {
  const nativeChannels: MessageChannel[] = [];
  beforeEach(() => {
    licensing.admit.mockReset().mockResolvedValue({ tier: "development" });
    native.open.mockReset();
    native.open.mockImplementation(() => {
      const channel = new MessageChannel(); nativeChannels.push(channel);
      return Promise.resolve({ status: "open" as const, port: channel.port1, dispose: () => { channel.port1.close(); channel.port2.close(); } });
    });
    vi.stubGlobal("Worker", vi.fn());
    vi.stubGlobal("location", new URL("https://app.example.test/editor/"));
    vi.stubGlobal("navigator", { storage: undefined });
    vi.stubGlobal("crossOriginIsolated", false);
  });
  afterEach(() => {
    for (const channel of nativeChannels.splice(0)) { channel.port1.close(); channel.port2.close(); }
    vi.unstubAllGlobals();
    fake.events.length = 0; fake.created.length = 0; fake.runtime = undefined; fake.assetsDisposed = 0;
  });

  it.each(["system", "userspace"] as const)("%s refuses new and restore creation before runtime activation when admission fails", async mode => {
    vi.stubGlobal("crossOriginIsolated", true);
    for (const restorePoint of ["none", "latest", { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: "2026-10-22T00:00:00.000Z" }] as const) {
      for (const reason of ["license-required", "license-invalid"] as const) {
        const error = new VMError("PERMISSION_DENIED", "license refusal", { reason, rejected: reason === "license-required" ? "public-requires-license" : "expired" });
        licensing.admit.mockRejectedValue(error);
        fake.assetsDisposed = 0;
        await expect(createVM({ mode, workspaceId: "licensed-recovery", restorePoint })).rejects.toBe(error);
        expect(fake.created).toEqual([]);
        expect(fake.events).toEqual([]);
        expect(fake.assetsDisposed).toBe(1);
      }
    }
  });

  it("connects automatic acceleration without a runtime option and disables all automatic handlers with off", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    for (const commandInterceptors of [undefined, "auto", "off"] as const) {
      fake.runtime = fakeRuntime(() => Promise.resolve());
      const vm = await createVM({ mode: "userspace", ...(commandInterceptors === undefined ? {} : { commandInterceptors }) });
      const created = fake.created.at(-1);
      if (commandInterceptors === "off") {
        expect(created).not.toHaveProperty("nativeExecutionPort");
        expect(created).not.toHaveProperty("interceptors");
      } else {
        expect(created).toHaveProperty("nativeExecutionPort");
        expect(created).toHaveProperty("interceptors");
      }
      await vm.dispose();
    }
    expect(native.open).toHaveBeenCalledTimes(2);
    expect(native.open).toHaveBeenCalledWith("/oxidevm/runtime/", undefined);
  });

  it("reports unavailable automatic acceleration before creating the VM", async () => {
    const failure = new VMError("FEATURE_NOT_AVAILABLE", "Execution origin unavailable");
    native.open.mockRejectedValueOnce(failure);
    await expect(createVM({ mode: "userspace" })).rejects.toBe(failure);
    expect(fake.created).toEqual([]);
    expect(fake.assetsDisposed).toBe(1);
  });

  it("opens without a native port when the runtime publishes no descriptor, warns once, and reports it", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    native.open.mockResolvedValueOnce({ status: "absent", reason: "descriptor-absent" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fake.runtime = fakeRuntime(() => Promise.resolve());
    const vm = await createVM({ mode: "userspace" });
    try {
      expect(fake.created.at(-1)).not.toHaveProperty("nativeExecutionPort");
      expect(vm.capabilities.commandAcceleration).toEqual({ available: false, reason: "runtime-unsupported" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("native-node-api.json");
      expect(String(warn.mock.calls[0]?.[0])).toContain('commandInterceptors: "off"');
    } finally {
      warn.mockRestore();
      await vm.dispose();
    }
  });

  it("opens with native acceleration off when the runtime answers the descriptor with an HTML page", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const actual = await vi.importActual<typeof NativeExecution>("./native-execution.js");
    native.open.mockImplementationOnce(actual.openNativeExecution);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("<!doctype html><title>app</title>", {
      status: 200, headers: { "content-type": "text/html; charset=utf-8" },
    }))));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fake.runtime = fakeRuntime(() => Promise.resolve());
    const vm = await createVM({ mode: "userspace" });
    try {
      expect(native.open).toHaveBeenCalledTimes(1);
      expect(fake.created.at(-1)).not.toHaveProperty("nativeExecutionPort");
      expect(vm.capabilities.commandAcceleration).toEqual({ available: false, reason: "runtime-unsupported" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await vm.dispose();
    }
  });

  it("reports native acceleration as available only when its port opened, and not-configured when off", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    fake.runtime = fakeRuntime(() => Promise.resolve());
    const automatic = await createVM({ mode: "userspace" });
    expect(automatic.capabilities.commandAcceleration).toEqual({ available: true });
    await automatic.dispose();
    fake.runtime = fakeRuntime(() => Promise.resolve());
    const disabled = await createVM({ mode: "userspace", commandInterceptors: "off" });
    expect(disabled.capabilities.commandAcceleration).toEqual({ available: false, reason: "not-configured" });
    expect(native.open).toHaveBeenCalledTimes(1);
    await disabled.dispose();
  });

  it("enables the packaged compiler by default and leaves System mode and opt-out unchanged", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    for (const options of [{ mode: "userspace" }, { mode: "userspace", commandInterceptors: "off" }, { mode: "system" }] as const) {
      fake.runtime = fakeRuntime(() => Promise.resolve());
      const vm = await createVM(options);
      const created = fake.created.at(-1);
      if (options.mode === "userspace" && !("commandInterceptors" in options)) {
        expect(created).toHaveProperty("interceptors", [{ command: "tsc", worker: new URL("../assets/interceptors/tsc.worker.js", import.meta.url).href }]);
      } else expect(created).not.toHaveProperty("interceptors");
      await vm.dispose();
    }
  });

  it.each(["userspace", "system"] as const)("%s connects once through vm.network after readiness and before resolving", async mode => {
    const connect = vi.fn<VMNetwork["connect"]>(() => Promise.resolve());
    const runtime = fakeRuntime(connect); fake.runtime = runtime;
    const signal = new AbortController().signal;
    const connection = { kind: "server", url: "https://relay.example.test/oxidevm/", sessionUrl: "/api/oxidevm/relay-session" } satisfies RelayConnectionOptions;
    const network = { mode: "relay", connection } as const;
    const onProgress = (progress: { readonly phase: string }) => { if (progress.phase === "ready") fake.events.push("ready"); };
    const vm = mode === "system" ? await createVM({ mode, network, signal, onProgress }) : await createVM({ mode, network, signal, onProgress });
    expect(fake.events).toEqual(["boot", "mount", "connect", "ready"]);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(connection, { signal });
    expect(vm.network).toBe(runtime.network);
    expect(fake.created).toEqual([expect.objectContaining({ mode, network: "local" })]);
    expect(fake.created[0]).not.toHaveProperty("relayUrl");
    await vm.dispose();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("keeps guest sockets local and never connects without relay options", async () => {
    const connect = vi.fn<VMNetwork["connect"]>(() => Promise.resolve());
    fake.runtime = fakeRuntime(connect);
    const vm = await createVM({ mode: "userspace", network: { mode: "local" } });
    await vm.dispose();
    expect(connect).not.toHaveBeenCalled();
    expect(fake.created[0]).not.toHaveProperty("interceptors");
    expect(fake.created).toEqual([expect.objectContaining({ network: "local" })]);
  });

  it.each(["userspace", "system"] as const)("%s disposes the VM and rejects with the owner's typed relay error", async mode => {
    const failure = relayError("relay-not-found");
    fake.runtime = fakeRuntime(() => Promise.reject(failure));
    const phases: string[] = [];
    const options = { network: { mode: "relay", connection: { kind: "personal", workspaceName: "My project" } }, onProgress: (progress: { readonly phase: string }) => { phases.push(progress.phase); } } as const;
    await expect(mode === "system" ? createVM({ ...options, mode }) : createVM({ ...options, mode })).rejects.toBe(failure);
    expect(fake.events).toEqual(["boot", "mount", "connect", "dispose"]);
    expect(fake.assetsDisposed).toBe(1);
    expect(phases).not.toContain("ready");
  });

  it("forwards creation cancellation to the connection and rolls the VM back", async () => {
    const controller = new AbortController();
    fake.runtime = fakeRuntime((_options, request) => {
      controller.abort();
      return request?.signal?.aborted === true ? Promise.reject(new VMError("ABORTED", "Relay connection cancelled")) : Promise.resolve();
    });
    await expect(createVM({ mode: "userspace", network: { mode: "relay", connection: { kind: "personal" } }, signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(fake.events).toEqual(["boot", "mount", "connect", "dispose"]);
    expect(fake.assetsDisposed).toBe(1);
  });

  it("keeps the relay failure when disposing the VM also fails", async () => {
    fake.runtime = fakeRuntime(() => Promise.reject(relayError("approval-denied")), () => Promise.reject(new VMError("GUEST_CRASH", "workers did not stop")));
    await expect(createVM({ mode: "userspace", network: { mode: "relay", connection: { kind: "personal" } } }))
      .rejects.toMatchObject({ code: "RELAY_ERROR", detail: { reason: "approval-denied", cleanupFailed: true, cleanupError: { code: "GUEST_CRASH" } } });
    expect(fake.assetsDisposed).toBe(1);
  });
});

/** Strict test-project compile contract: each rejected relay shape sits beside an accepted one. */
function networkContract(userspace: UserspaceVM, signal: AbortSignal): readonly Promise<unknown>[] {
  const network: VMNetwork = userspace.network;
  return [
    createVM({ mode: "userspace", network: { mode: "local" } }),
    createVM({ mode: "userspace", network: { mode: "relay", connection: { kind: "personal", workspaceName: "My project" } } }),
    createVM({ mode: "system", network: { mode: "relay", connection: { kind: "server", url: new URL("https://app.example/oxidevm-relay/"), sessionUrl: "/api/oxidevm/relay-session", headers: { authorization: "Bearer browser-safe" } } } }),
    // @ts-expect-error no relay URL is allowed in local-only networking
    createVM({ mode: "userspace", network: { mode: "local", relayUrl: "https://relay.example.com" } }),
    // @ts-expect-error relay mode needs explicit authenticated connection options
    createVM({ mode: "userspace", network: { mode: "relay" } }),
    // @ts-expect-error the protocol-1 relay URL option no longer exists, even beside a valid connection
    createVM({ mode: "userspace", network: { mode: "relay", connection: { kind: "personal" }, relayUrl: "wss://relay.example.com/" } }),
    userspace.network.connect({ kind: "personal", workspaceName: "My project" }, { signal }),
    userspace.network.connect({ kind: "server", url: "https://app.example/oxidevm-relay/" }),
    // @ts-expect-error personal pairing cannot accept an operator endpoint
    userspace.network.connect({ kind: "personal", url: "https://relay.example.com/" }),
    // @ts-expect-error server connection options require a URL
    userspace.network.connect({ kind: "server" }),
    // @ts-expect-error personal pairing cannot accept operator credentials
    userspace.network.connect({ kind: "personal", headers: { authorization: "secret" } }),
    network.disconnect(),
    network.watch(state => { if (state.kind === "failed") expect(typeof state.reason).toBe("string"); }, { signal }),
  ];
}
it("keeps the compiler-checked public relay contract", () => { expect(typeof networkContract).toBe("function"); });
