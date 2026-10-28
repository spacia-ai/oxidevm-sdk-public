import { VMError } from "./errors.js";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserAssistance } from "./browser-assistance.js";
import { integer, record } from "./decode.js";
import { controlResponseDecoders, PROTOCOL_VERSION, type ControlOperations } from "./protocol.js";
import { WorkerClient } from "./worker-client.js";
import { validateSpawnSpec } from "./vm-options.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: {
  version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1", nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } }, compiler: { sha256: "0".repeat(64), bytes: 1 }, runtime: { sha256: "0".repeat(64), bytes: 1 },
} }));

afterEach(() => vi.unstubAllGlobals());

it("reserves four SDK startup slots before acquiring a shared bootstrap", async () => {
  class Control extends EventTarget {
    readonly postMessage = vi.fn<(value: unknown) => void>();
    terminate(): void {}
  }
  vi.stubGlobal("document", {}); vi.stubGlobal("crossOriginIsolated", true);
  const worker = new Control();
  const client = new WorkerClient<ControlOperations>(worker, controlResponseDecoders);
  const owner = new BrowserAssistance(client, { executionOrigin: "https://execution.test", manifestUrl: "https://execution.test/manifest.json" });
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const spawn = (signal: AbortSignal) => owner.spawn(validateSpawnSpec({ command: "node", args: ["entry.cjs"], cwd: "/", signal,
    execution: { kind: "assisted-node", profile: "node24-next16-v1" } }));
  const pending = controllers.slice(0, 4).map(controller => expect(spawn(controller.signal)).rejects.toMatchObject({ code: "ABORTED" }));
  try {
    const fifth = controllers[4];
    if (fifth === undefined) throw new Error("missing fifth request");
    const refused = expect(spawn(fifth.signal)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    fifth.abort();
    await refused;
    expect(worker.postMessage).toHaveBeenCalledOnce();
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    owner.dispose(); client.terminate();
  }
});

it("keeps a shared bootstrap alive for remaining waiters and cancels it when the final waiter aborts", async () => {
  class Control extends EventTarget {
    attempts = 0;
    cancellations = 0;
    postMessage(value: unknown): void {
      const request = record(value, "request");
      if (request["type"] === "cancel") { this.cancellations += 1; return; }
      expect(request["type"]).toBe("assistance-prepare");
      this.attempts += 1;
    }
    terminate(): void {}
  }
  vi.stubGlobal("document", {});
  vi.stubGlobal("crossOriginIsolated", true);
  const worker = new Control();
  const client = new WorkerClient<ControlOperations>(worker, controlResponseDecoders);
  const owner = new BrowserAssistance(client, { executionOrigin: "https://execution.test", manifestUrl: "https://execution.test/manifest.json" });
  const spawn = (signal: AbortSignal) => owner.spawn(validateSpawnSpec({ command: "node", args: ["entry.cjs"], cwd: "/", signal,
    execution: { kind: "assisted-node", profile: "node24-next16-v1" } }));
  try {
    const first = new AbortController(); const second = new AbortController();
    const a = expect(spawn(first.signal)).rejects.toMatchObject({ code: "ABORTED" });
    const b = expect(spawn(second.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(worker.attempts).toBe(1);
    first.abort(); await a;
    expect(worker.cancellations).toBe(0);
    second.abort(); await b;
    expect(worker.cancellations).toBe(1);
    const retry = new AbortController();
    const c = expect(spawn(retry.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(worker.attempts).toBe(2);
    retry.abort(); await c;
    expect(worker.cancellations).toBe(2);
  } finally { owner.dispose(); client.terminate(); }
});

it("shares concurrent bootstrap and retries a failed attempt on the next explicit spawn", async () => {
  class Control extends EventTarget {
    attempts = 0;
    postMessage(value: unknown): void {
      const request = record(value, "request");
      expect(request["type"]).toBe("assistance-prepare");
      const id = integer(request["id"], "request id", 1);
      const attempt = ++this.attempts;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
        id, version: PROTOCOL_VERSION, ok: false,
        error: { code: "FEATURE_NOT_AVAILABLE", message: `Guest not ready: ${attempt}` },
      } })));
    }
    terminate(): void {}
  }
  vi.stubGlobal("document", {});
  vi.stubGlobal("crossOriginIsolated", true);
  const worker = new Control();
  const client = new WorkerClient<ControlOperations>(worker, controlResponseDecoders);
  const owner = new BrowserAssistance(client, { executionOrigin: "https://execution.test", manifestUrl: "https://execution.test/manifest.json" });
  const spec = validateSpawnSpec({ command: "node", args: ["entry.cjs"], cwd: "/", execution: { kind: "assisted-node", profile: "node24-next16-v1" } });
  try {
    const first = owner.spawn(spec); const concurrent = owner.spawn(spec);
    await Promise.all([expect(first).rejects.toThrow("Guest not ready: 1"), expect(concurrent).rejects.toThrow("Guest not ready: 1")]);
    expect(worker.attempts).toBe(1);
    await expect(owner.spawn(spec)).rejects.toThrow("Guest not ready: 2");
    expect(worker.attempts).toBe(2);
  } finally { owner.dispose(); }
});

it.each(["silent", "generation", "reported"])("supervises idle control ownership: %s", async scenario => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  let output: MessagePort | undefined;
  let preparations = 0;
  const ports: MessagePort[] = [];
  class Control extends EventTarget {
    silent = false;
    reported = false;
    readonly terminate = vi.fn();
    postMessage(value: unknown): void {
      const input = record(value, "control request");
      if (this.silent || input["type"] === "cancel") return;
      if (this.reported && input["type"] === "assistance-status") {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
          id: input["id"], version: PROTOCOL_VERSION, ok: false,
          error: { code: "GUEST_CRASH", message: "Execution broker liveness deadline exceeded", detail: { owner: "broker" } },
        } })));
        return;
      }
      const port = input["port"]; if (port instanceof MessagePort) ports.push(port);
      if (input["type"] === "assistance-prepare") preparations += 1;
      if (input["type"] === "assistance-spawn" && port instanceof MessagePort) output = port;
      const response = input["type"] === "assistance-prepare" || input["type"] === "assistance-status" ? { ...binding }
        : input["type"] === "assistance-spawn" ? { pid: 1, sessionId: 1 } : undefined;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: input["id"], version: PROTOCOL_VERSION, ok: true, value: response } })));
    }
  }
  const frame = {
    hidden: false, allow: "", src: "", onload: undefined as (() => void) | null | undefined, onerror: null,
    sandbox: { add() {} }, remove: vi.fn(),
    contentWindow: { postMessage(value: unknown): void {
      const input = record(value, "bootstrap"); const port = input["port"];
      if (!(port instanceof MessagePort)) throw new Error("missing port");
      ports.push(port);
      port.postMessage({ kind: "broker-ready", binding: input["binding"], nonce: input["nonce"] });
    } },
  };
  vi.stubGlobal("document", { createElement: () => frame, body: { append: () => frame.onload?.() } });
  vi.stubGlobal("location", { origin: "https://ide.test" });
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "0".repeat(64), bytes: 1 }, profile: "node24-next16-v1", nextCompiler: { version: "16.2.12", bindings: { sha256: "0".repeat(64), bytes: 1 }, wasm: { sha256: "0".repeat(64), bytes: 1 } },
    compiler: { sha256: "0".repeat(64), bytes: 1 }, runtime: { sha256: "0".repeat(64), bytes: 1 } }))));
  const worker = new Control();
  const client = new WorkerClient<ControlOperations>(worker, controlResponseDecoders);
  const owner = new BrowserAssistance(client, { executionOrigin: "https://execution.test", manifestUrl: "https://execution.test/manifest.json" });
  try {
    const process = await owner.spawn(validateSpawnSpec({ command: "node", args: ["entry.cjs"], execution: { kind: "assisted-node", profile: "node24-next16-v1" } }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.lifetime.aborted).toBe(false);
    expect(preparations).toBe(1);
    if (scenario === "generation") {
      if (output === undefined) throw new Error("Missing process output");
      output.postMessage({ version: PROTOCOL_VERSION, sessionId: 1, sequence: 1, type: "exit", termination: { kind: "exit", code: 0 } });
      await process.exit;
      binding.generation += 1;
      const restarted = await owner.spawn(validateSpawnSpec({ command: "node", args: ["entry.cjs"], execution: { kind: "assisted-node", profile: "node24-next16-v1" } }));
      expect(preparations).toBe(2);
      expect(frame.remove).toHaveBeenCalledOnce();
      expect(client.lifetime.aborted).toBe(false);
      output.postMessage({ version: PROTOCOL_VERSION, sessionId: 1, sequence: 1, type: "exit", termination: { kind: "exit", code: 0 } });
      await restarted.exit;
      return;
    }
    worker.silent = scenario === "silent";
    worker.reported = scenario === "reported";
    await vi.advanceTimersByTimeAsync(75_000);
    expect(client.lifetime.aborted).toBe(true);
    await expect(process.exit).rejects.toMatchObject({ code: "GUEST_CRASH",
      message: scenario === "reported" ? "Execution broker liveness deadline exceeded" : "Assistance control lifeline lost",
      ...(scenario === "reported" ? { detail: { owner: "broker" } } : {}),
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(frame.remove).toHaveBeenCalledOnce();
  } finally {
    owner.dispose(); client.terminate();
    for (const port of ports) port.close();
    vi.useRealTimers();
  }
});

it.each([false, true])("returns bootstrap grants after download failure; cleanup failure=%s fences the client", async cleanupFailure => {
  const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1 };
  const credits = [1, 4098].map((bytes, index) => ({ ...binding, kind: "grant", producer: "bootstrap", process: null,
    pool: "data", bytes, entries: index === 0 ? 1 : 32, sequence: index + 1, reservation: index + 1 }));
  const operations: unknown[] = [];
  class Control extends EventTarget {
    readonly terminate = vi.fn();
    postMessage(value: unknown): void {
      const request = record(value, "control request"); operations.push(request["type"]);
      const id = integer(request["id"], "request id", 1);
      const prepare = request["type"] === "assistance-prepare";
      if (!prepare) expect(request).toMatchObject({ type: "assistance-bootstrap-release", ...binding, reservation: 1 });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
        id, version: PROTOCOL_VERSION,
        ...(!prepare && cleanupFailure ? { ok: false, error: { code: "GUEST_CRASH", message: "cleanup lost" } }
          : { ok: true, value: prepare ? { ...binding, credits } : undefined }),
      } })));
    }
  }
  vi.stubGlobal("document", {}); vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("unavailable", { status: 503 }))));
  const worker = new Control(); const client = new WorkerClient<ControlOperations>(worker, controlResponseDecoders);
  const owner = new BrowserAssistance(client, { executionOrigin: "https://execution.test", manifestUrl: "https://execution.test/manifest.json" });
  try {
    await expect(owner.spawn(validateSpawnSpec({ command: "node", args: ["entry.cjs"], cwd: "/",
      execution: { kind: "assisted-node", profile: "node24-next16-v1" } }))).rejects.toMatchObject({ code: cleanupFailure ? "GUEST_CRASH" : "CORE_LOAD_FAILED" });
    expect(operations).toEqual(["assistance-prepare", "assistance-bootstrap-release"]);
    expect(client.lifetime.aborted).toBe(cleanupFailure);
  } finally { owner.dispose(); client.terminate(); }
});

it.each(["allow", "deny"] as const)("persists %s decisions without changing the failed installation or retrying it", async decision => {
  const posted: unknown[] = [];
  class Control extends EventTarget {
    postMessage(value: unknown): void {
      const request = record(value, "request"); posted.push(value);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
        version: PROTOCOL_VERSION, id: request["id"], ok: true, value: undefined,
      } })));
    }
    terminate(): void {}
  }
  const client = new WorkerClient<ControlOperations>(new Control(), controlResponseDecoders);
  const identity = { name: "sharp", version: "0.34.3", integrity: `sha512-${btoa("a".repeat(64))}` };
  const approveBuildScript = vi.fn(() => Promise.resolve(decision));
  const owner = new BrowserAssistance(client, { executionOrigin: "https://execution.test", manifestUrl: "https://execution.test/manifest.json", approveBuildScript });
  const failure = new VMError("STORAGE_ERROR", "Explicit retry required", { exitCode: 1, blockedBuilds: [identity] });
  try {
    await expect(owner.approveBlockedBuilds(failure, "a".repeat(64))).rejects.toBe(failure);
    expect(approveBuildScript).toHaveBeenCalledOnce();
    expect(posted).toEqual([{ version: PROTOCOL_VERSION, id: 1, type: "assistance-build-policy", workspaceBaseSha256: "a".repeat(64), decisions: [{ ...identity, decision }] }]);
  } finally { owner.dispose(); client.terminate(); }
});

it("cancels a pending build approval on disposal without writing or retrying", async () => {
  class Control extends EventTarget { readonly postMessage = vi.fn(); terminate(): void {} }
  const worker = new Control();
  const client = new WorkerClient<ControlOperations>(worker, controlResponseDecoders);
  const answer = Promise.withResolvers<"allow">();
  let signal: AbortSignal | undefined;
  const owner = new BrowserAssistance(client, { executionOrigin: "https://execution.test", manifestUrl: "https://execution.test/manifest.json",
    approveBuildScript: request => { signal = request.signal; return answer.promise; },
  });
  const failure = new VMError("STORAGE_ERROR", "Blocked", { exitCode: 1, blockedBuilds: [
    { name: "sharp", version: "0.34.3", integrity: `sha512-${btoa("a".repeat(64))}` },
  ] });
  try {
    const pending = expect(owner.approveBlockedBuilds(failure, "a".repeat(64))).rejects.toMatchObject({ code: "ABORTED" });
    expect(() => owner.assertPreparationAvailable()).toThrow("approval");
    owner.dispose();
    await pending;
    expect(signal?.aborted).toBe(true);
    answer.resolve("allow"); await answer.promise;
    expect(worker.postMessage).not.toHaveBeenCalled();
  } finally { owner.dispose(); client.terminate(); }
});
