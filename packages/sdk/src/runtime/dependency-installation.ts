import { VMError } from "./errors.js";
import { workerClientForPort } from "./worker-client.js";
import { installationResponseDecoders, type DependencyInstallationOperations } from "./protocol/dependency-installation.js";
import type { DependencyInstallHandle } from "./vm-types.js";

/** Browser-side handle only. The control worker owns preparation and publication. */
export async function connectDependencyInstallation(port: MessagePort, lifetime: AbortSignal): Promise<DependencyInstallHandle> {
  const client = workerClientForPort<DependencyInstallationOperations>(port, installationResponseDecoders);
  const lost = () => client.terminate(new VMError("ABORTED", "Dependency preparation owner was disposed"));
  lifetime.addEventListener("abort", lost, { once: true });
  if (lifetime.aborted) lost();
  const exit = client.request("exit", undefined);
  const generation = client.request("generation", undefined);
  void exit.catch(() => {}); void generation.catch(() => {});
  let completed = false;
  let killing: Promise<void> | undefined;
  const release = () => {
    if (!completed || killing !== undefined) return;
    lifetime.removeEventListener("abort", lost);
    client.terminate();
  };
  const stdio = client.request("stdio", undefined);
  void Promise.allSettled([stdio, exit, generation]).then(() => { completed = true; release(); });
  let streams;
  try { streams = await stdio; }
  catch (error) { lifetime.removeEventListener("abort", lost); client.terminate(); throw error; }
  const writer = streams.stdin.getWriter();
  const stdin = new WritableStream<Uint8Array>({
    async write(value) {
      if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) throw new VMError("INVALID_ARGUMENT", "Installer stdin requires bytes");
      for (let offset = 0; offset < value.length; offset += 65_536) await writer.write(value.slice(offset, offset + 65_536));
    },
    async close() { try { await writer.close(); } finally { writer.releaseLock(); } },
    async abort(reason) { try { await writer.abort(reason); } finally { writer.releaseLock(); } },
  });
  return { stdin, stdout: output(streams.stdout), stderr: output(streams.stderr), exit, generation,
    kill(signal = "TERM") {
      if (signal !== "TERM" && signal !== "KILL" && signal !== "INT" && signal !== "HUP") return Promise.reject(new VMError("INVALID_ARGUMENT", "Unsupported installer signal"));
      if (completed) return Promise.resolve();
      if (killing !== undefined) return Promise.reject(new VMError("QUOTA_EXCEEDED", "Installer signal already pending"));
      killing = client.request("kill", { signal }).finally(() => { killing = undefined; release(); });
      return killing;
    },
  };
}

function output(stream: ReadableStream<unknown>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); controller.close(); return; }
        if (!(next.value instanceof Uint8Array) || !(next.value.buffer instanceof ArrayBuffer) || next.value.length > 65_536) {
          throw new VMError("PROTOCOL_ERROR", "Invalid installation output chunk");
        }
        controller.enqueue(next.value);
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        reader.releaseLock(); controller.error(error);
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
}
