import { describe, expect, it } from "vitest";

import {
  type JitCompilerHost,
  type JitCompilerTransport,
  JitCompilerClient,
} from "./jit-compiler-client.js";
import {
  JIT_COMPILER_PROTOCOL_VERSION,
  decodeJitCompilerRequest,
  decodeJitCompilerResponse,
} from "./jit-compiler-protocol.js";

/** The smallest valid module: magic and version. */
const EMPTY_MODULE = [0, 97, 115, 109, 1, 0, 0, 0];

class FakeCompiler implements JitCompilerTransport {
  readonly sent: unknown[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  ready: Int32Array<SharedArrayBuffer> | null = null;
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();

  postMessage(message: unknown, transfer: Transferable[]): void {
    const request = decodeJitCompilerRequest(message);
    if (request.type === "attach") this.ready = request.ready;
    this.sent.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  /** Answers compile `id` of `epoch` as the worker does: counter first, then the message. */
  answer(id: number, epoch: number, compiled = true): void {
    if (this.ready !== null) Atomics.add(this.ready, 0, 1);
    this.#emit("message", new MessageEvent("message", {
      data: compiled
        ? {
            version: JIT_COMPILER_PROTOCOL_VERSION,
            type: "compiled",
            id,
            epoch,
            module: new WebAssembly.Module(new Uint8Array(EMPTY_MODULE)),
            compileMilliseconds: 1.5,
          }
        : {
            version: JIT_COMPILER_PROTOCOL_VERSION,
            type: "failed",
            id,
            epoch,
            errorName: "CompileError",
            reason: "bad module",
          },
    }));
  }

  crash(): void {
    this.#emit("error", new Event("error"));
  }

  #emit(type: string, event: Event): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

interface Harness {
  readonly host: JitCompilerHost;
  readonly compilers: FakeCompiler[];
  readonly advance: (milliseconds: number) => void;
}

function harness(shared = true, failCreation = false): Harness {
  const compilers: FakeCompiler[] = [];
  let now = 0;
  let timer: { readonly at: number; readonly callback: () => void } | undefined;
  return {
    compilers,
    host: {
      createTransport: () => {
        if (failCreation) throw new Error("workers are unavailable");
        const compiler = new FakeCompiler();
        compilers.push(compiler);
        return compiler;
      },
      now: () => now,
      timer: {
        arm: (callback, milliseconds) => { timer = { at: now + milliseconds, callback }; },
        cancel: () => { timer = undefined; },
      },
      sharedCounter: () => shared
        ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
        : null,
    },
    advance: (milliseconds) => {
      now += milliseconds;
      const due = timer;
      if (due !== undefined && due.at <= now) {
        timer = undefined;
        due.callback();
      }
    },
  };
}

function moduleBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(EMPTY_MODULE);
}

describe("JIT compiler client", () => {
  it("transfers module bytes and reports the compiled module once its message arrives", () => {
    const { host, compilers } = harness();
    const client = new JitCompilerClient(host);
    const bytes = moduleBytes();
    const id = client.submit(bytes);
    const compiler = compilers[0];
    if (compiler === undefined) throw new Error("no compiler worker");

    expect(compiler.transfers.at(-1)).toEqual([bytes.buffer]);
    expect(client.inFlight).toBe(1);
    expect(client.resultReady()).toBe(false);
    compiler.answer(id, 1);
    expect(client.hasResults()).toBe(true);
    const [result] = client.take();
    expect(result).toMatchObject({ kind: "compiled", id, compileMilliseconds: 1.5 });
    expect(client.inFlight).toBe(0);
    expect(client.resultReady()).toBe(false);
  });

  it("signals a posted result before its message is received", () => {
    const { host, compilers } = harness();
    const client = new JitCompilerClient(host);
    client.submit(moduleBytes());
    const ready = compilers[0]?.ready;
    if (ready === undefined || ready === null) throw new Error("no ready counter");

    Atomics.add(ready, 0, 1);
    expect(client.resultReady()).toBe(true);
    expect(client.hasResults()).toBe(false);
  });

  it("works without shared memory, signalling only received results", () => {
    const { host, compilers } = harness(false);
    const client = new JitCompilerClient(host);
    const id = client.submit(moduleBytes());

    expect(compilers[0]?.ready).toBeNull();
    expect(client.resultReady()).toBe(false);
    compilers[0]?.answer(id, 1);
    expect(client.resultReady()).toBe(true);
  });

  it("ignores results from before a reset", () => {
    const { host, compilers } = harness();
    const client = new JitCompilerClient(host);
    const id = client.submit(moduleBytes());
    client.reset();
    compilers[0]?.answer(id, 1);

    expect(client.take()).toEqual([]);
    expect(client.resultReady()).toBe(false);
    const next = client.submit(moduleBytes());
    compilers[0]?.answer(next, 2, false);
    expect(client.take()).toEqual([
      { kind: "failed", id: next, errorName: "CompileError", reason: "bad module" },
    ]);
  });

  it("abandons every compile when its worker fails and stops after repeated failures", () => {
    const { host, compilers } = harness();
    const client = new JitCompilerClient(host, {
      maximumInFlight: 4,
      timeoutMilliseconds: 1_000,
      maximumFailures: 2,
    });
    const first = client.submit(moduleBytes());
    const second = client.submit(moduleBytes());
    compilers[0]?.crash();

    expect(compilers[0]?.terminated).toBe(true);
    expect(client.take()).toEqual([
      { kind: "abandoned", id: first, reason: "worker-failure" },
      { kind: "abandoned", id: second, reason: "worker-failure" },
    ]);
    expect(client.accepts()).toBe(true);
    const third = client.submit(moduleBytes());
    expect(compilers).toHaveLength(2);
    compilers[1]?.crash();
    expect(client.take()).toEqual([{ kind: "abandoned", id: third, reason: "worker-failure" }]);
    expect(client.unavailable).toBe("compiler-failed");
    expect(client.accepts()).toBe(false);
  });

  it("abandons compiles and restarts the worker after the timeout", () => {
    const { host, compilers, advance } = harness();
    const client = new JitCompilerClient(host, {
      maximumInFlight: 4,
      timeoutMilliseconds: 1_000,
      maximumFailures: 2,
    });
    const id = client.submit(moduleBytes());
    advance(600);
    expect(client.take()).toEqual([]);
    advance(400);

    expect(client.take()).toEqual([{ kind: "abandoned", id, reason: "timeout" }]);
    expect(compilers[0]?.terminated).toBe(true);
    expect(client.unavailable).toBeNull();
  });

  it("bounds compiles in flight", () => {
    const { host } = harness();
    const client = new JitCompilerClient(host, {
      maximumInFlight: 1,
      timeoutMilliseconds: 1_000,
      maximumFailures: 2,
    });
    client.submit(moduleBytes());

    expect(client.accepts()).toBe(false);
  });

  it("reports an unavailable compiler when its worker cannot start", () => {
    const { host } = harness(true, true);
    const client = new JitCompilerClient(host);
    const id = client.submit(moduleBytes());

    expect(client.unavailable).toBe("compiler-unavailable");
    expect(client.accepts()).toBe(false);
    expect(client.take()).toEqual([{ kind: "abandoned", id, reason: "worker-failure" }]);
  });
});

describe("JIT compiler protocol", () => {
  it("accepts compile requests with owned bytes and rejects shared or oversized ones", () => {
    const request = decodeJitCompilerRequest({
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "compile",
      id: 1,
      epoch: 1,
      bytes: moduleBytes(),
    });
    expect(request.type).toBe("compile");
    for (const bytes of [
      new Uint8Array(new SharedArrayBuffer(8)),
      new Uint8Array(),
      new Uint8Array(4 * 1024 * 1024 + 1),
    ]) {
      expect(() => decodeJitCompilerRequest({
        version: JIT_COMPILER_PROTOCOL_VERSION,
        type: "compile",
        id: 1,
        epoch: 1,
        bytes,
      })).toThrow("JIT compiler module bytes are invalid");
    }
  });

  it("accepts an attach with a one-element shared counter or none", () => {
    expect(decodeJitCompilerRequest({
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "attach",
      ready: null,
    })).toEqual({ version: JIT_COMPILER_PROTOCOL_VERSION, type: "attach", ready: null });
    expect(() => decodeJitCompilerRequest({
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "attach",
      ready: new Int32Array(2),
    })).toThrow("JIT compiler ready counter is invalid");
  });

  it("rejects responses with extra fields, wrong versions or no module", () => {
    // Version 1 failures carried no error name, so code-memory exhaustion was indistinguishable.
    expect(() => decodeJitCompilerResponse({
      version: 1,
      type: "failed",
      id: 1,
      epoch: 1,
      reason: "x",
    })).toThrow("JIT compiler response version is invalid");
    expect(decodeJitCompilerResponse({
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "failed",
      id: 1,
      epoch: 1,
      errorName: "RangeError",
      reason: "out of memory",
    })).toMatchObject({ type: "failed", errorName: "RangeError", reason: "out of memory" });
    expect(() => decodeJitCompilerResponse({
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "failed",
      id: 1,
      epoch: 1,
      reason: "x",
    })).toThrow("missing protocol field errorName");
    expect(() => decodeJitCompilerResponse({
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "failed",
      id: 1,
      epoch: 1,
      errorName: "E".repeat(65),
      reason: "x",
    })).toThrow("JIT compiler failure name is too long");
    expect(() => decodeJitCompilerResponse({
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "compiled",
      id: 1,
      epoch: 1,
      module: {},
      compileMilliseconds: 1,
    })).toThrow("JIT compiler response module is invalid");
    expect(() => decodeJitCompilerResponse({
      version: JIT_COMPILER_PROTOCOL_VERSION,
      type: "failed",
      id: 1,
      epoch: 1,
      errorName: "CompileError",
      reason: "x",
      extra: true,
    })).toThrow();
  });
});
