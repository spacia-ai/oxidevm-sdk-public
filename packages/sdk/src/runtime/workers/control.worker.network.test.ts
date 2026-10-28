import { afterEach, expect, it, vi } from "vitest";

import { createDiskBridgeBuffer } from "../disk-bridge.js";
import { createFrameBridgeBuffer, frameBridgeGeneration } from "../frame-bridge.js";
import { PROTOCOL_VERSION } from "../protocol.ts";
import type * as CoreModule from "./control/core.js";
import { recordingCore } from "./control/core.test-support.js";
import { SnapshotSession } from "./control/snapshot-session.js";

class WorkerScope extends EventTarget {
  readonly postMessage = vi.fn();
  readonly close = vi.fn();
}

const ports: MessagePort[] = [];
function port(): MessagePort {
  const channel = new MessageChannel();
  ports.push(channel.port1, channel.port2);
  return channel.port1;
}

afterEach(() => {
  for (const open of ports.splice(0)) open.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("./control/core.js");
  vi.resetModules();
});

function send(scope: WorkerScope, data: Readonly<Record<string, unknown>>): void {
  scope.dispatchEvent(new MessageEvent("message", { data }));
}

function boot(id: number, hostDiskBytes?: number): Readonly<Record<string, unknown>> {
  return {
    id,
    version: PROTOCOL_VERSION,
    type: "boot-system",
    memoryMiB: 16,
    kernel: Uint8Array.of(1),
    commandLine: "console=hvc0",
    ...(hostDiskBytes === undefined ? {} : { hostDiskBytes }),
  };
}

it("attaches the explicit network link before managed and user-supplied kernel boots", async () => {
  const { core, calls } = recordingCore();
  vi.doMock("./control/core.js", async (importOriginal) => ({
    ...(await importOriginal<typeof CoreModule>()),
    loadCore: () => Promise.resolve(core),
  }));
  vi.spyOn(SnapshotSession.prototype, "rememberBoot").mockResolvedValue(undefined);
  const scope = new WorkerScope();
  vi.stubGlobal("self", scope);
  await import("./control.worker.ts");

  const bridge = createFrameBridgeBuffer();
  const doorbell = new MessageChannel();
  ports.push(doorbell.port1, doorbell.port2);
  doorbell.port2.postMessage({ version: 1, type: "router-ready" });
  send(scope, {
    id: 1, version: PROTOCOL_VERSION, type: "initialize", coreWasmUrl: "https://ide.example.test/oxidevm_core.wasm",
    sharedCoreWasmUrl: "https://ide.example.test/oxidevm_core_shared.wasm", workspaceId: "network-link", memoryMiB: 16, vcpus: 1,
    snapshotPort: port(), diskBridge: createDiskBridgeBuffer(), diskPort: port(),
  });
  send(scope, { id: 2, version: PROTOCOL_VERSION, type: "network-link-connect", bridge, doorbell: doorbell.port1 });
  send(scope, boot(3, 1 << 20));
  await vi.waitFor(() => { expect(scope.postMessage).toHaveBeenCalledTimes(3); });
  const managed = calls.map((call) => call.name);
  const attach = managed.indexOf("oxidevm_system_network_attach");
  expect(attach).toBeGreaterThan(managed.indexOf("oxidevm_system_create"));
  expect(attach).toBeLessThan(managed.indexOf("oxidevm_system_boot"));
  expect(frameBridgeGeneration(bridge)).toBe(1);

  calls.length = 0;
  send(scope, boot(4));
  await vi.waitFor(() => { expect(scope.postMessage).toHaveBeenCalledTimes(4); });
  expect(calls.map((call) => call.name)).toContain("oxidevm_system_network_attach");
  expect(frameBridgeGeneration(bridge)).toBe(2);
  for (const [response] of scope.postMessage.mock.calls) expect(response).toMatchObject({ ok: true });
}, 30_000);
