import { VMError } from "./errors.js";
import { expect, it, vi } from "vitest";
import { createAdvancedTestVM as createSystemRuntimeVM } from "./system-vm.test-support.js";
import { integer, record } from "./decode.js";
import { decodeAssistanceControl } from "./protocol/assistance-control.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { serveDependencyInstallation } from "./workers/control/dependency-installation-channel.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

it.each(["ready", "boot-failed", "blocked"])("connects public preparation and preserves installer outcome (%s)", async scenario => {
  const failedBoot = scenario === "boot-failed";
  const blocked = scenario === "blocked";
  const identity = { name: "sharp", version: "0.34.3", integrity: `sha512-${btoa("a".repeat(64))}` };
  const approveBuildScript = vi.fn(() => Promise.resolve("allow" as const));
  const decisions: unknown[] = [];
  const ports: MessagePort[] = [];
  const cleanups: (() => void)[] = [];
  const generation = Promise.withResolvers<string>();
  const requests: unknown[] = [];
  const signals: string[] = [];
  let execution: { port: MessagePort; id: number } | undefined;
  class Worker extends EventTarget {
    constructor(_url: URL, readonly options: WorkerOptions) { super(); }
    postMessage(value: unknown, transfer: readonly Transferable[]): void {
      for (const item of transfer) if (item instanceof MessagePort) ports.push(item);
      const input = record(value, "worker request");
      const type = input["type"];
      if (type === "connect-system" || type === "connect-link") return;
      const id = integer(input["id"], "request id", 1);
      let result: unknown;
      switch (type) {
        case "initialize": result = this.options.name === "oxidevm-control" ? { execution: "serialized", vcpus: 1, sharedMemory: false } : undefined; break;
        case "prepare-managed-image": result = { id: "fixture", version: "1", memoryMiB: failedBoot ? 512 : 256, vcpus: 1,
          workspaceBaseSha256: "a".repeat(64), kernel: Uint8Array.of(1), commandLine: "console=hvc0", diskBytes: 4096,
          aot: { kind: "skipped", reason: "no-catalog" }, runtimes: { alpine: "3.24", node: "24", bun: "1", next: "16" } }; break;
        case "wait-agent": result = { version: "7", capabilities: { files: true, processes: true } }; break;
        case "start-system": {
          const port = input["port"];
          if (!(port instanceof MessagePort)) throw new Error("execution port missing");
          execution = { port, id: integer(input["sessionId"], "session", 1) }; break;
        }
        case "stop-system": execution?.port.postMessage({ version: PROTOCOL_VERSION, sessionId: execution.id,
          sequence: 1, type: "exit", exit: { kind: "halted", steps: 0n } }); break;
        case "agent-restore-workspace": result = true; break;
        case "agent-sync-workspace": result = true; break;
        case "agent-workspace-delta": case "commit-workspace-delta": throw new Error("Streamed workspace cannot use a legacy delta");
        case "assistance-build-policy": decisions.push(decodeAssistanceControl(value)); break;
        case "assistance-install": {
          const command = decodeAssistanceControl(value);
          if (command.type !== "assistance-install") throw new Error("unexpected preparation");
          requests.push(command);
          cleanups.push(serveDependencyInstallation(command.port, Promise.resolve({
            stdin: new WritableStream<Uint8Array>(),
            stdout: new ReadableStream<Uint8Array>({ start: controller => { controller.enqueue(Uint8Array.of(65)); controller.close(); } }),
            stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
            exit: Promise.resolve({ code: blocked ? 1 : 0 }), generation: generation.promise,
            kill: signal => { signals.push(signal ?? "TERM"); return Promise.resolve(); },
          }), vi.fn()));
          break;
        }
        case "network-link-connect":
        case "initial-start-retire":
        case "quiesce-disk": case "configure-system-aot": case "boot-system": case "assistance-network-attach":
        case "assistance-dispose": case "dispose": break;
        default: throw new Error(`unexpected operation ${String(type)}`);
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id, version: PROTOCOL_VERSION, ok: true, value: result } })));
    }
    terminate(): void {}
  }
  vi.stubGlobal("Worker", Worker);
  vi.stubGlobal("location", { href: "https://ide.example.test/" });
  const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "preparation", memoryMiB: 256, vcpus: 1, network: "local",
    assistance: { executionOrigin: "https://execution.example.test", manifestUrl: "https://execution.example.test/manifest.json", approveBuildScript } });
  try {
    if (failedBoot) {
      await expect(vm.bootManagedImage("/managed/manifest.json")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(vm.prepareDependencies()).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
      expect(requests).toHaveLength(0);
    } else {
      await vm.bootManagedImage("/managed/manifest.json");
      const cancellation = new AbortController();
      const handle = await vm.prepareDependencies({ cwd: "/app", frozenLockfile: false, signal: cancellation.signal });
      expect(requests).toEqual([expect.objectContaining({ type: "assistance-install", cwd: "/app", frozenLockfile: false, workspaceBaseSha256: "a".repeat(64) })]);
      expect(await new Response(handle.stdout).text()).toBe("A");
      await expect(handle.exit).resolves.toEqual({ code: blocked ? 1 : 0 });
      if (blocked) {
        const rejected = expect(handle.generation).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { exitCode: 1 } });
        generation.reject(new VMError("STORAGE_ERROR", "Explicit retry required", { exitCode: 1, blockedBuilds: [identity] }));
        await rejected;
        expect(approveBuildScript).toHaveBeenCalledOnce();
        expect(decisions).toEqual([expect.objectContaining({ type: "assistance-build-policy", workspaceBaseSha256: "a".repeat(64),
          decisions: [{ ...identity, decision: "allow" }] })]);
        expect(requests).toHaveLength(1);
        await expect(handle.exit).resolves.toEqual({ code: 1 });
        return;
      }
      cancellation.abort();
      await vi.waitFor(() => expect(signals).toEqual(["KILL"]));
      generation.resolve("b".repeat(64));
      await expect(handle.generation).resolves.toBe("b".repeat(64));
      await vm.diagnostics.bootSystem({ kernel: Uint8Array.of(1), commandLine: "console=hvc0" });
      await expect(vm.prepareDependencies()).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
      expect(requests).toHaveLength(1);
    }
  } finally {
    await vm.dispose();
    for (const cleanup of cleanups) cleanup();
    for (const port of ports) port.close();
    vi.unstubAllGlobals();
  }
});
