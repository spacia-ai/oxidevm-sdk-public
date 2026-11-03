import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeLaunchDescriptor, encodeLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { buildRelease, COMMAND_DECLARATION, SERVICE_DECLARATION } from "../../../wasm/runner/fixtures.test-support.js";
import { JsProcessWorkers } from "./driver.js";
import { prepareModuleStart } from "./module-artifacts.js";
import { ModuleCopies } from "./module-copies.js";
import { takeModuleLease } from "./module-leases.js";
import { fakeLocks, suppliedOf } from "./module-commands.test-support.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const live = (): AbortSignal => new AbortController().signal;
const service = (workspaceId = "ws-1") => buildRelease({ adapter: "export default () => ({ protocols: {} });", declaration: { ...SERVICE_DECLARATION, requires: { host: ["files.sync"] } }, workspaceId });

describe("exclusive-service leases (ADR 0028)", () => {
  it("wasm-module-busy before spawning", async () => {
    const release = await service(), { locks, held } = fakeLocks(), copies = new ModuleCopies();
    const first = await prepareModuleStart(encodeLaunchArgument(release.descriptor), suppliedOf(release), { copies, locks }, live());
    expect([...held]).toEqual(["oxidevm-module:ws-1:db"]);
    // The second start is refused before its files are read or hashed, and before any process exists.
    const digest = vi.spyOn(crypto.subtle, "digest"), copiesBefore = copies.bytes;
    await expect(prepareModuleStart(encodeLaunchArgument(release.descriptor), suppliedOf(release), { copies, locks }, live())).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", detail: { reason: "wasm-module-busy" } });
    expect([digest.mock.calls.length, copies.bytes]).toEqual([0, copiesBefore]);
    // Another workspace is another lease.
    const other = await service("ws-2");
    const second = await prepareModuleStart(encodeLaunchArgument(other.descriptor), suppliedOf(other), { copies, locks }, live());
    first.lease?.release(); second.lease?.release();
    await vi.waitFor(() => { expect(held.size).toBe(0); });
  });

  it("the lease ends with the process", async () => {
    vi.stubGlobal("self", { location: new URL("https://example.test/app"), crossOriginIsolated: true });
    const release = await service(), { locks, held } = fakeLocks(), copies = new ModuleCopies();
    const workers = new JsProcessWorkers({ runtime: { instance: new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0))), memory: new WebAssembly.Memory({ initial: 1 }) }, active: () => false, wake: () => {} });
    const start = await prepareModuleStart(encodeLaunchArgument(release.descriptor), suppliedOf(release), { copies, locks }, live());
    // A launch Rust never admitted is retired, and its lease with it.
    workers.retireLaunch(workers.registerModule(start.launch, start.lease));
    await vi.waitFor(() => { expect(held.size).toBe(0); });
    const again = await prepareModuleStart(encodeLaunchArgument(release.descriptor), {}, { copies, locks }, live());
    workers.registerModule(again.launch, again.lease);
    expect(held.size).toBe(1);
    // The VM going away ends every registered launch's lease.
    workers.dispose();
    await vi.waitFor(() => { expect(held.size).toBe(0); });
  });

  it("takes no lease for a module that is not exclusive, and refuses a worker without Web Locks", async () => {
    const command = await buildRelease({ adapter: "export default () => ({ main: () => 0 });", declaration: COMMAND_DECLARATION });
    await expect(takeModuleLease(command.descriptor, undefined)).resolves.toBeUndefined();
    const release = await service();
    await expect(takeModuleLease(release.descriptor, undefined)).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-prerequisite" } });
    const withoutWorkspace = Object.fromEntries(Object.entries(release.descriptor).filter(([key]) => key !== "workspaceId"));
    await expect(takeModuleLease(decodeLaunchDescriptor(withoutWorkspace), fakeLocks().locks)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
