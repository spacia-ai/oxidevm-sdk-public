import { afterEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./errors.js";
import { decodeWatchOptions, formatListenerAddress, LISTENING_PORTS_POLL_MS, watchListeningPorts, type ListeningPortsRead } from "./listening-ports.js";
import type { ListeningPort } from "./vm-types.js";

const a: ListeningPort = { port: 3000, address: "0.0.0.0", program: "bun dev", previewable: true };
const b: ListeningPort = { port: 8080, address: "::", program: null, previewable: true };

afterEach(() => {
  vi.useRealTimers();
});

describe("watchListeningPorts", () => {
  it("calls back once with the first list and then only on changes", async () => {
    const controller = new AbortController();
    const reads: ListeningPortsRead[] = [
      { generation: 1n, ports: [a] }, { generation: 1n, ports: null }, { generation: 2n, ports: [{ ...a }] }, { generation: 3n, ports: [a, b] },
    ];
    const known: (bigint | null)[] = [];
    const calls: (readonly ListeningPort[])[] = [];
    const read = (generation: bigint | null): Promise<ListeningPortsRead> => {
      known.push(generation);
      const next = reads.shift();
      if (next === undefined) controller.abort();
      return Promise.resolve(next ?? { generation: 3n, ports: null });
    };
    await watchListeningPorts(read, (ports) => { calls.push(ports); }, controller.signal, () => Promise.resolve());
    expect(calls).toEqual([[a], [a, b]]);
    expect(known.slice(0, 4)).toEqual([null, 1n, 1n, 2n]);
  });

  it("waits between reads and resolves when its signal aborts, even mid-wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let reads = 0;
    const watching = watchListeningPorts(() => { reads += 1; return Promise.resolve({ generation: 1n, ports: [a] }); }, () => undefined, controller.signal);
    await vi.advanceTimersByTimeAsync(LISTENING_PORTS_POLL_MS - 1);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  it("rejects with the read's VMError", async () => {
    const failure = new VMError("PROTOCOL_ERROR", "Userspace VM is disposed");
    await expect(watchListeningPorts(() => Promise.reject(failure), () => undefined, new AbortController().signal, () => Promise.resolve()))
      .rejects.toBe(failure);
  });

  it("refuses options without an AbortSignal", () => {
    const signal = new AbortController().signal;
    expect(decodeWatchOptions({ signal })).toEqual({ signal });
    for (const options of [undefined, null, {}, { signal: {} }, { signal, interval: 1 }]) {
      let code: unknown;
      try { decodeWatchOptions(options); } catch (error) { code = error instanceof VMError ? error.code : undefined; }
      expect(code).toBe("INVALID_ARGUMENT");
    }
  });
});

function v6(...words: number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => { view.setUint16(index * 2, word); });
  return bytes;
}

describe("formatListenerAddress", () => {
  it("writes IPv4 addresses in dotted form from the first four bytes", () => {
    expect(formatListenerAddress(4, Uint8Array.of(127, 0, 0, 2, ...new Uint8Array(12)))).toBe("127.0.0.2");
    expect(formatListenerAddress(4, new Uint8Array(16))).toBe("0.0.0.0");
  });

  it.each([
    [new Uint8Array(16), "::"],
    [v6(0, 0, 0, 0, 0, 0, 0, 1), "::1"],
    [v6(0xfe80, 0, 0, 0, 0, 0, 0, 1), "fe80::1"],
    [v6(0x2001, 0xdb8, 0, 0, 1, 0, 0, 1), "2001:db8::1:0:0:1"],
    [v6(0x2001, 0xdb8, 0, 1, 1, 1, 1, 1), "2001:db8:0:1:1:1:1:1"],
    [v6(0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001), "::ffff:127.0.0.1"],
    [v6(0x2001, 0xdb8, 0xabcd, 0x12, 0, 0, 0, 0), "2001:db8:abcd:12::"],
  ])("writes %s as %s (RFC 5952)", (bytes, text) => {
    expect(formatListenerAddress(6, bytes)).toBe(text);
  });
});
