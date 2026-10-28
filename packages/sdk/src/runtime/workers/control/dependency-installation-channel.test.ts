import { expect, it, vi } from "vitest";
import type { DependencyInstallHandle } from "../../vm-types.js";
import { workerClientForPort } from "../../worker-client.js";
import { installationResponseDecoders, type DependencyInstallationOperations } from "../../protocol/dependency-installation.js";
import { serveDependencyInstallation } from "./dependency-installation-channel.js";

it("transfers process streams while exit and generation complete independently", async () => {
  const pair = new MessageChannel();
  const client = workerClientForPort<DependencyInstallationOperations>(pair.port1, installationResponseDecoders);
  const exit = Promise.withResolvers<{ code: number }>();
  const generation = Promise.withResolvers<string>();
  const written: number[] = [];
  const kill = vi.fn(async () => {});
  const close = serveDependencyInstallation(pair.port2, Promise.resolve({
    stdin: new WritableStream<Uint8Array>({ write: bytes => { written.push(...bytes); } }),
    stdout: new ReadableStream<Uint8Array>({ start: controller => { controller.enqueue(Uint8Array.of(7)); controller.close(); } }),
    stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
    exit: exit.promise, generation: generation.promise, kill,
  }), vi.fn());
  try {
    const streams = await client.request("stdio", undefined);
    const writer = streams.stdin.getWriter();
    await writer.write(Uint8Array.of(3)); await writer.close();
    const output = streams.stdout.getReader();
    expect((await output.read()).value).toEqual(Uint8Array.of(7));
    expect((await output.read()).done).toBe(true);
    const ending = client.request("exit", undefined);
    const committed = client.request("generation", undefined);
    exit.resolve({ code: 37 });
    await expect(ending).resolves.toEqual({ code: 37 });
    expect(written).toEqual([3]);
    await client.request("kill", { signal: "INT" });
    expect(kill).toHaveBeenCalledWith("INT");
    generation.reject(new Error("installation failed"));
    await expect(committed).rejects.toThrow("installation failed");
  } finally { close(); client.terminate(); }
});

it("retirement rejects pending startup and cancels its existing owner", async () => {
  const pair = new MessageChannel();
  const client = workerClientForPort<DependencyInstallationOperations>(pair.port1, installationResponseDecoders);
  const pending = Promise.withResolvers<DependencyInstallHandle>();
  const cancel = vi.fn(() => pending.reject(new Error("cancelled")));
  const close = serveDependencyInstallation(pair.port2, pending.promise, cancel);
  try {
    const ready = client.request("stdio", undefined);
    const rejected = expect(ready).rejects.toMatchObject({ code: "ABORTED" });
    // Observe request delivery before retiring the server, without guessing a delay.
    await new Promise<void>(resolve => pair.port2.addEventListener("message", () => resolve(), { once: true }));
    close();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    close();
    expect(cancel).toHaveBeenCalledOnce();
  } finally { close(); client.terminate(); }
});

it("invalid messages fail pending requests and retire the preparation owner", async () => {
  const pair = new MessageChannel();
  const client = workerClientForPort<DependencyInstallationOperations>(pair.port1, installationResponseDecoders);
  const pending = Promise.withResolvers<DependencyInstallHandle>();
  const cancel = vi.fn(() => pending.reject(new Error("retired")));
  const close = serveDependencyInstallation(pair.port2, pending.promise, cancel);
  try {
    const result = client.request("generation", undefined);
    const rejected = expect(result).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await new Promise<void>(resolve => pair.port2.addEventListener("message", () => resolve(), { once: true }));
    pair.port1.postMessage({ id: 2, version: -1, type: "kill", signal: "KILL" });
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  } finally { close(); client.terminate(); }
});
