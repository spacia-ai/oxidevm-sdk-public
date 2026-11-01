import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeVM } from "./index.js";
import type { ModuleCommandsRequest } from "./protocol/userspace-module-commands.js";
import { ScriptedWorker } from "./system-vm.test-support.js";

/** The module-command requests the Userspace backend received, with their signals. */
const received = vi.hoisted(() => new Array<readonly unknown[]>());

vi.mock("./userspace-process.js", async () => {
  const { nativeBackend } = await import("./userspace-vm.test-support.js");
  return {
    UserspaceProcessBackend: {
      create: () => Promise.resolve({
        ...nativeBackend(),
        moduleCommands: (request: unknown, signal: unknown) => { received.push([request, signal]); return Promise.resolve({ operation: "disable" }); },
      }),
    },
  };
});

afterEach(() => { received.length = 0; ScriptedWorker.reset(); vi.unstubAllGlobals(); });

// Engine ADR 0027: the VM's module commands live in its Userspace worker; the runtime VM only forwards to its backend.
it("hands module-command requests to the Userspace backend with the caller's signal, and refuses them once disposed", async () => {
  vi.stubGlobal("Worker", ScriptedWorker);
  vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const vm = await createRuntimeVM({ mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local" });
  if (vm.moduleCommands === undefined) throw new Error("A Userspace runtime VM has module commands");
  const request: ModuleCommandsRequest = { operation: "disable", registration: 2 }, signal = new AbortController().signal;
  await expect(vm.moduleCommands(request, { signal })).resolves.toEqual({ operation: "disable" });
  await expect(vm.moduleCommands(request)).resolves.toEqual({ operation: "disable" });
  expect(received).toEqual([[request, signal], [request, undefined]]);
  await vm.dispose();
  await expect(vm.moduleCommands(request)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(received).toHaveLength(2);
});
