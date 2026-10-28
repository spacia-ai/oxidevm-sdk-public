import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMachine } from "./machine.js";
import type { RawMachine } from "./machine.js";
import type * as EngineAssets from "./engine-assets.js";
import type { LoadedEngineAssets } from "./engine-assets.js";
import type { RelayConnectionOptions, VMNetwork } from "./contracts.js";
import { decodeControlIncoming, PROTOCOL_VERSION } from "./runtime/protocol.js";
import type { CoreProbeExit, SystemExecutionEvent } from "./runtime/protocol.js";
import { relayError } from "./runtime/relay-errors.js";
import type { RuntimeVM, RuntimeVMDiagnostics } from "./runtime/vm-types.js";

/** The runtime members a raw boot uses before and while it connects a relay. */
type FakeRuntime = Pick<RuntimeVM, "dispose" | "network"> & { readonly diagnostics: Pick<RuntimeVMDiagnostics, "bootSystem" | "startSystem" | "writeSystemConsole"> };

const raw = vi.hoisted(() => {
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

vi.mock("./engine-assets.js", async importOriginal => ({
  ...await importOriginal<typeof EngineAssets>(),
  loadEngineAssets: (): Promise<LoadedEngineAssets> => Promise.resolve({
    urls: new Map(["oxidevm_core.wasm", "oxidevm_core_shared.wasm", "oxidevm_netstack.wasm"].map(name => [name, `blob:${name}`])),
    compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))),
    dispose: () => { raw.assetsDisposed += 1; },
  }),
}));
vi.mock("./runtime/system-vm.js", () => ({ createSystemRuntimeVM: (options: unknown) => raw.create(options) }));

const boot = { kernel: new Uint8Array([1]), commandLine: "console=ttyS0" };

it("preserves explicit human-console selection at the worker boundary", () => {
  const request = { version: PROTOCOL_VERSION, id: 1, type: "boot-system", memoryMiB: 256, kernel: new Uint8Array([1]), commandLine: "console=ttyS0", console: "serial" };
  expect(decodeControlIncoming(request)).toMatchObject({ console: "serial" });
  expect(() => decodeControlIncoming({ ...request, console: "agent" })).toThrow();
});
it("validates byte-array boot inputs and remains safe to import on a server", async () => {
  await expect(bootMachine({ mode: "system", boot: { kernel: new Uint8Array(), commandLine: "console=ttyS0" }, memoryMiB: 256 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(bootMachine({ mode: "system", boot, memoryMiB: 256 })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
});
it.each([
  { kind: "server", url: "http://relay.example.com/" },
  { kind: "server", url: "relay.example.com" },
  { kind: "personal", workspaceName: "" },
] satisfies RelayConnectionOptions[])("rejects raw relay connection %j before using browser state", async connection => {
  await expect(bootMachine({ mode: "system", boot, memoryMiB: 256, network: { mode: "relay", connection } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

function fakeRuntime(connect: VMNetwork["connect"]): FakeRuntime {
  const execution = {
    events: new ReadableStream<SystemExecutionEvent>(),
    exit: new Promise<CoreProbeExit>(() => {}),
    pause: () => Promise.resolve(), resume: () => Promise.resolve(), stop: () => Promise.resolve(),
  };
  return {
    diagnostics: {
      bootSystem: () => { raw.events.push("boot"); return Promise.resolve(); },
      startSystem: () => { raw.events.push("start"); return Promise.resolve(execution); },
      writeSystemConsole: () => Promise.resolve(),
    },
    network: {
      state: { kind: "off" },
      connect: (options, request) => { raw.events.push("connect"); return connect(options, request); },
      disconnect: () => Promise.resolve(),
      watch: () => Promise.resolve(),
    },
    dispose: () => { raw.events.push("dispose"); return Promise.resolve(); },
  };
}

describe("raw machine relay networking", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", vi.fn());
    vi.stubGlobal("location", new URL("https://app.example.test/"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    raw.events.length = 0; raw.created.length = 0; raw.runtime = undefined; raw.assetsDisposed = 0;
  });

  it("connects through the machine's network owner after configuration and before execution starts", async () => {
    const connect = vi.fn<VMNetwork["connect"]>(() => Promise.resolve());
    raw.runtime = fakeRuntime(connect);
    const signal = new AbortController().signal;
    const machine = await bootMachine({ mode: "system", boot, memoryMiB: 256, network: { mode: "relay", connection: { kind: "server", url: "https://relay.example.test/oxidevm/" } }, signal });
    expect(raw.events).toEqual(["boot", "connect", "start"]);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ kind: "server", url: "https://relay.example.test/oxidevm/" }, { signal });
    expect(raw.created).toEqual([expect.objectContaining({ network: "local" })]);
    expect(raw.created[0]).not.toHaveProperty("relayUrl");
    await machine.dispose();
  });

  it("keeps a local machine's sockets local", async () => {
    const connect = vi.fn<VMNetwork["connect"]>(() => Promise.resolve());
    raw.runtime = fakeRuntime(connect);
    const machine = await bootMachine({ mode: "system", boot, memoryMiB: 256 });
    expect(raw.events).toEqual(["boot", "start"]);
    expect(connect).not.toHaveBeenCalled();
    await machine.dispose();
  });

  it("disposes the machine and rejects with the owner's typed relay error when connecting fails", async () => {
    const failure = relayError("authentication-failed");
    raw.runtime = fakeRuntime(() => Promise.reject(failure));
    await expect(bootMachine({ mode: "system", boot, memoryMiB: 256, network: { mode: "relay", connection: { kind: "personal" } } })).rejects.toBe(failure);
    expect(raw.events).toEqual(["boot", "connect", "dispose"]);
    expect(raw.assetsDisposed).toBe(1);
  });
});

/** Strict test-project compile contract: raw machines take the managed VM's network options. */
function machineNetworkContract(kernel: Uint8Array): readonly Promise<RawMachine>[] {
  return [
    bootMachine({ mode: "system", boot: { kernel, commandLine: "console=ttyS0" }, memoryMiB: 256, network: { mode: "relay", connection: { kind: "server", url: "https://app.example/oxidevm-relay/" } } }),
    // @ts-expect-error raw machines no longer take a relay URL string, even beside a valid connection
    bootMachine({ mode: "system", boot: { kernel, commandLine: "console=ttyS0" }, memoryMiB: 256, network: { mode: "relay", connection: { kind: "personal" }, relayUrl: "wss://relay.example.com/" } }),
    // @ts-expect-error raw relay mode needs explicit connection options
    bootMachine({ mode: "system", boot: { kernel, commandLine: "console=ttyS0" }, memoryMiB: 256, network: { mode: "relay" } }),
  ];
}
it("keeps the compiler-checked raw relay contract", () => { expect(typeof machineNetworkContract).toBe("function"); });
