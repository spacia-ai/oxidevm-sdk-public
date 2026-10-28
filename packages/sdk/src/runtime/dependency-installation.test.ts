import { expect, it, vi } from "vitest";
import { connectDependencyInstallation } from "./dependency-installation.js";
import { serveDependencyInstallation } from "./workers/control/dependency-installation-channel.js";

it("exposes bounded typed process streams and independent generation through a real port", async () => {
  const pair = new MessageChannel();
  const lifetime = new AbortController();
  const exit = Promise.withResolvers<{ code: number }>();
  const generation = Promise.withResolvers<string>();
  const writes: number[] = [];
  const inputClosed = Promise.withResolvers<undefined>();
  const kill = vi.fn(async () => {});
  const close = serveDependencyInstallation(pair.port2, Promise.resolve({
    stdin: new WritableStream<Uint8Array>({ write: value => { writes.push(value.length); }, close: () => inputClosed.resolve(undefined) }),
    stdout: new ReadableStream<Uint8Array>({ start: controller => { controller.enqueue(Uint8Array.of(9)); controller.close(); } }),
    stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
    exit: exit.promise, generation: generation.promise, kill,
  }), vi.fn());
  try {
    const handle = await connectDependencyInstallation(pair.port1, lifetime.signal);
    const writer = handle.stdin.getWriter();
    await writer.write(new Uint8Array(131_073)); await writer.close();
    await inputClosed.promise;
    expect(writes).toEqual([65_536, 65_536, 1]);
    expect(await new Response(handle.stdout).arrayBuffer()).toEqual(Uint8Array.of(9).buffer);
    exit.resolve({ code: 0 });
    await expect(handle.exit).resolves.toEqual({ code: 0 });
    await handle.kill("INT");
    expect(kill).toHaveBeenCalledWith("INT");
    generation.resolve("a".repeat(64));
    await expect(handle.generation).resolves.toBe("a".repeat(64));
  } finally { lifetime.abort(); close(); }
});

it("rejects pending results when the control worker lifetime ends", async () => {
  const pair = new MessageChannel();
  const lifetime = new AbortController();
  const connecting = connectDependencyInstallation(pair.port1, lifetime.signal);
  const rejected = expect(connecting).rejects.toMatchObject({ code: "ABORTED" });
  lifetime.abort();
  await rejected;
  pair.port2.close();
});
