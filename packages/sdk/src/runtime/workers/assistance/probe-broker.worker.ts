import { exactKeys, integer, record, string } from "../../decode.ts";
import { closeMailbox, completeReply, createMailbox, takeRequest } from "./mailbox.ts";

declare const ASSISTANCE_COMPILER_SHA256: string;

// Experimental topology probe. It never dispatches guest or storage operations.
let connected = false;
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (connected) return;
  const message = record(event.data, "probe broker bootstrap");
  exactKeys(message, ["port", "nonce"]);
  const port = message["port"];
  if (!(port instanceof MessagePort)) throw new TypeError("probe requires MessagePort");
  const nonce = string(message["nonce"], "probe nonce");
  connected = true;
  let active: { sequence: number; worker: Worker; buffer: SharedArrayBuffer; deadline: ReturnType<typeof setTimeout> } | undefined;
  let lastSequence = 0;

  function stop(): void {
    if (active === undefined) return;
    clearTimeout(active.deadline);
    closeMailbox(active.buffer);
    active.worker.terminate();
    active = undefined;
  }

  port.onmessage = (input: MessageEvent<unknown>) => {
    try {
      const request = record(input.data, "probe request");
      const kind = request["kind"];
      if (kind === "dispose") {
        exactKeys(request, ["kind"]);
        stop();
        port.close();
        self.close();
        return;
      }
      if (kind === "cancel") {
        exactKeys(request, ["kind", "sequence"]);
        const sequence = integer(request["sequence"], "probe sequence", 1, 0x7fff_ffff);
        if (active?.sequence === sequence) {
          stop();
          port.postMessage({ kind: "cancelled", sequence });
        }
        return;
      }
      exactKeys(request, ["kind", "sequence", "bytes"]);
      const sequence = integer(request["sequence"], "probe sequence", 1, 0x7fff_ffff);
      const bytes = request["bytes"];
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 65_536) throw new RangeError("probe byte limit");
      if (kind === "reply") {
        if (active?.sequence === sequence) completeReply(active.buffer, sequence, new Uint8Array(bytes));
        return;
      }
      if (kind !== "run" || active !== undefined || sequence <= lastSequence) throw new Error("invalid probe transition");
      lastSequence = sequence;
      const buffer = createMailbox();
      const worker = new Worker("/process.worker.js", { type: "module" });
      const deadline = setTimeout(() => {
        if (active?.worker !== worker) return;
        stop();
        port.postMessage({ kind: "failed", sequence, reason: "deadline-exceeded" });
      }, 10_000);
      active = { sequence, buffer, worker, deadline };
      worker.onerror = () => {
        if (active?.worker !== worker) return;
        stop();
        port.postMessage({ kind: "failed", sequence, reason: "worker-lost" });
      };
      worker.onmessage = (output: MessageEvent<unknown>) => {
        if (active?.worker !== worker) return;
        try {
          const result = record(output.data, "probe process result");
          if (result["kind"] === "pending") {
            exactKeys(result, ["kind"]);
            const snapshot = new Uint8Array(takeRequest(buffer, sequence)).buffer;
            port.postMessage({ kind: "host-request", sequence, bytes: snapshot }, [snapshot]);
          } else {
            exactKeys(result, ["kind", "bytes", "isolated", "networkDenied", "childDenied", "context", "modules"]);
            if (result["kind"] !== "complete" || !(result["bytes"] instanceof ArrayBuffer) ||
                typeof result["isolated"] !== "boolean" || typeof result["networkDenied"] !== "boolean" ||
                typeof result["childDenied"] !== "boolean" || typeof result["context"] !== "string" ||
                typeof result["modules"] !== "string" || result["modules"].length > 65_536) throw new Error("invalid probe result");
            stop();
            port.postMessage({ ...result, sequence }, [result["bytes"]]);
          }
        } catch {
          stop();
          port.postMessage({ kind: "failed", sequence, reason: "invalid-process-reply" });
        }
      };
      void loadCompiler().then((compilerModule) => {
        if (active?.worker === worker) worker.postMessage({ buffer, sequence, bytes, compilerModule }, [bytes]);
      }).catch(() => {
        if (active?.worker !== worker) return;
        stop();
        port.postMessage({ kind: "failed", sequence, reason: "compiler-initialization" });
      });
    } catch {
      stop();
      port.postMessage({ kind: "failed", reason: "invalid-request" });
    }
  };
  port.start();
  port.postMessage({ kind: "ready", nonce, isolated: crossOriginIsolated });
});

let compiler: Promise<WebAssembly.Module> | undefined;
function loadCompiler(): Promise<WebAssembly.Module> {
  compiler ??= (async () => {
    const response = await fetch("/compiler.wasm", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok || response.body === null) throw new Error("missing compiler artifact");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 32 * 1024 * 1024) throw new Error("compiler artifact exceeds limit");
        chunks.push(new Uint8Array(chunk.value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== ASSISTANCE_COMPILER_SHA256) {
      throw new Error("compiler artifact integrity mismatch");
    }
    return WebAssembly.compile(bytes);
  })();
  return compiler;
}
