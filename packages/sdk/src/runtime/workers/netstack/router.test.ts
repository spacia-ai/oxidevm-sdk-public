import { afterEach, describe, expect, it, vi } from "vitest";

import { VMError } from "../../errors.js";
import { NETSTACK_BUFFER_BYTES, NETSTACK_EXPORTS } from "../../netstack-abi.js";
import { NetstackRouter } from "./router.js";

const BUFFER = 1_024;

/** Router exports over a real memory whose functions succeed unless a test replaces them. */
function routerExports(overrides: Readonly<Record<string, unknown>> = {}) {
  // 18 pages hold the 1,114,112-byte buffer at its 1 KiB offset.
  const memory = new WebAssembly.Memory({ initial: 18, maximum: 24 });
  const calls: string[] = [];
  const functions: Record<string, unknown> = {
    oxidevm_netstack_api_version: () => 2,
    oxidevm_netstack_buffer_ptr: () => BUFFER,
    oxidevm_netstack_buffer_capacity: () => NETSTACK_BUFFER_BYTES,
    oxidevm_netstack_init: () => 0,
    oxidevm_netstack_frames_in: () => 0,
    oxidevm_netstack_frames_out: () => 0,
    oxidevm_netstack_poll: () => -1,
    oxidevm_netstack_tcp_open: () => 1,
    oxidevm_netstack_tcp_status: () => 1 | 0x100 | 0x200,
    oxidevm_netstack_tcp_send: (_id: number, length: number) => length,
    oxidevm_netstack_tcp_receive: () => 0,
    oxidevm_netstack_tcp_close: () => 0,
    oxidevm_netstack_counters: () => 352,
    oxidevm_netstack_network_set: () => 0,
    oxidevm_netstack_egress_next: () => 0,
    oxidevm_netstack_egress_complete: () => 0,
    oxidevm_netstack_egress_status: () => 0,
    oxidevm_netstack_egress_send: () => 0,
    oxidevm_netstack_egress_receive: () => 0,
    ...overrides,
  };
  const exports: Record<string, unknown> = { memory };
  for (const [name, run] of Object.entries(functions)) {
    exports[name] = typeof run === "function"
      ? (...args: unknown[]): unknown => {
          calls.push(name);
          return Reflect.apply(run, undefined, args);
        }
      : run;
  }
  return { exports, memory, calls };
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the router adapter", () => {
  it("re-creates views after an export grows memory", () => {
    const { exports, memory } = routerExports({
      oxidevm_netstack_frames_out: () => {
        new Uint8Array(memory.buffer, BUFFER, 3).set([7, 8, 9]);
        memory.grow(1);
        return 3;
      },
    });
    const router = NetstackRouter.fromExports(exports, 1n, 0);
    expect(router.framesOut(64)).toEqual(Uint8Array.of(7, 8, 9));
  });

  it("passes 64-bit seeds and times as two halves and reads unsigned results", () => {
    const seen: unknown[][] = [];
    const { exports } = routerExports({
      oxidevm_netstack_init: (...args: unknown[]) => {
        seen.push(args);
        return 0;
      },
      oxidevm_netstack_poll: (...args: unknown[]) => {
        seen.push(args);
        return 25;
      },
    });
    const router = NetstackRouter.fromExports(exports, 0x1_0000_0002n, 0x3_0000_0004);
    expect(router.poll(5.9)).toBe(25);
    expect(seen).toEqual([[2, 1, 4, 3], [5, 0]]);
  });

  it("answers no deadline for u32::MAX from poll, and busy for an open that returns 0", () => {
    const { exports } = routerExports({ oxidevm_netstack_tcp_open: () => 0 });
    const router = NetstackRouter.fromExports(exports, 1n, 0);
    expect(router.poll(0)).toBeUndefined();
    expect(router.open(3_000)).toEqual({ kind: "busy" });
  });

  it("turns a trap into RELAY_ERROR", () => {
    const { exports } = routerExports({
      oxidevm_netstack_poll: () => {
        throw new WebAssembly.RuntimeError("unreachable");
      },
    });
    const router = NetstackRouter.fromExports(exports, 1n, 0);
    const error = errorOf(() => router.poll(0));
    expect(error).toBeInstanceOf(VMError);
    expect(error).toMatchObject({ code: "RELAY_ERROR", detail: { reason: "trap" } });
  });

  it.each([
    ["an API version", { oxidevm_netstack_api_version: () => 1 }],
    ["a buffer capacity", { oxidevm_netstack_buffer_capacity: () => 4_096 }],
  ])("fails with reason version for a wrong %s", (_name, overrides) => {
    const { exports } = routerExports(overrides);
    expect(errorOf(() => NetstackRouter.fromExports(exports, 1n, 0)))
      .toMatchObject({ code: "CORE_LOAD_FAILED", detail: { component: "netstack", reason: "version" } });
  });

  it("fails with reason init when the router cannot start", () => {
    const { exports } = routerExports({ oxidevm_netstack_init: () => 1 });
    expect(errorOf(() => NetstackRouter.fromExports(exports, 1n, 0)))
      .toMatchObject({ code: "CORE_LOAD_FAILED", detail: { component: "netstack", reason: "init" } });
  });

  it.each([...NETSTACK_EXPORTS, "memory"])("requires the export %s", (name) => {
    const { exports } = routerExports();
    const rest = Object.fromEntries(Object.entries(exports).filter(([key]) => key !== name));
    expect(errorOf(() => NetstackRouter.fromExports(rest, 1n, 0)))
      .toMatchObject({ code: "CORE_LOAD_FAILED", detail: { component: "netstack", reason: "exports" } });
  });

  it("moves bytes through the fixed buffer for frames and connections", () => {
    const { exports, memory } = routerExports({
      oxidevm_netstack_frames_in: (length: number) => new Uint8Array(memory.buffer, BUFFER, length)[0] ?? 0,
      oxidevm_netstack_tcp_receive: (_id: number, maximum: number) => {
        new Uint8Array(memory.buffer, BUFFER, 2).set([0x6f, 0x6b]);
        return Math.min(2, maximum);
      },
    });
    const router = NetstackRouter.fromExports(exports, 1n, 0);
    expect(router.framesIn(Uint8Array.of(5, 1, 2))).toBe(5);
    expect(router.receive(1, 64)).toEqual(Uint8Array.of(0x6f, 0x6b));
    expect(router.send(1, new Uint8Array(10))).toBe(10);
    expect(router.status(1)).toEqual({ state: "connected", readable: true, writable: true });
    expect(router.counters().byteLength).toBe(352);
  });
});

describe("loading the router module", () => {
  const EMPTY_MODULE = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
  // (module (import "env" "f" (func)))
  const IMPORTING_MODULE = Uint8Array.of(
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x02, 0x09, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
  );

  it.each([
    ["a fetch that fails", () => Promise.reject(new TypeError("offline")), "fetch"],
    ["an HTTP error", () => Promise.resolve(new Response("missing", { status: 404 })), "fetch"],
    ["bytes that are not Wasm", () => Promise.resolve(new Response("not wasm")), "compile"],
    ["a module that imports", () => Promise.resolve(new Response(IMPORTING_MODULE)), "exports"],
    ["a module without the ABI", () => Promise.resolve(new Response(EMPTY_MODULE)), "exports"],
  ])("fails with CORE_LOAD_FAILED for %s", async (_name, answer, reason) => {
    vi.stubGlobal("fetch", vi.fn(answer));
    await expect(NetstackRouter.load("https://ide.example.test/oxidevm_netstack.wasm", 1n, 0))
      .rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { component: "netstack", reason } });
  });
});
