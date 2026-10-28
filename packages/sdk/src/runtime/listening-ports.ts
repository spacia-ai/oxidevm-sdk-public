// Listening ports a runtime VM reports, so previews can offer the apps that serve them.
import { VMError } from "./errors.ts";
import type { ListeningPort } from "./vm-types.js";

/** At most this many ports are reported, lowest first. */
export const MAX_LISTENING_PORTS = 256;
/** A program is reported in at most this many UTF-8 bytes. */
export const MAX_LISTENING_PROGRAM_LENGTH = 256;

/** A bound address as text: dotted IPv4 from the first four bytes; IPv6 in RFC 5952 form, with
 * IPv4-mapped addresses written ::ffff:a.b.c.d. */
export function formatListenerAddress(family: 4 | 6, bytes: Uint8Array): string {
  if (family === 4) return Array.from(bytes.subarray(0, 4), (byte) => String(byte)).join(".");
  const words = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return `::ffff:${formatListenerAddress(4, bytes.subarray(12, 16))}`;
  }
  // The longest run of two or more zero words, the first of equal runs, becomes "::".
  let start = -1;
  let length = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - index >= 2 && end - index > length) {
      start = index;
      length = end - index;
    }
    index = end;
  }
  const hex = words.map((word) => word.toString(16));
  return start < 0 ? hex.join(":") : `${hex.slice(0, start).join(":")}::${hex.slice(start + length).join(":")}`;
}

/** How often a watch rereads; a read whose generation did not move costs one Wasm call. */
export const LISTENING_PORTS_POLL_MS = 500;

/** One read: the list and the generation it belongs to, or `ports: null` when the generation the
 * reader already knew has not moved. */
export interface ListeningPortsRead {
  readonly generation: bigint;
  readonly ports: readonly ListeningPort[] | null;
}

/** Calls `onChange` with the first list, then whenever the list differs, until `signal` aborts.
 * Resolves on abort; rejects with the read's error. */
export async function watchListeningPorts(
  read: (known: bigint | null, signal: AbortSignal) => Promise<ListeningPortsRead>,
  onChange: (ports: readonly ListeningPort[]) => void,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = pollDelay,
): Promise<void> {
  let known: bigint | null = null;
  let current: readonly ListeningPort[] | undefined;
  // Read through a call: the signal may abort while a read or a wait is pending.
  const stopped = (): boolean => signal.aborted;
  while (!stopped()) {
    let result: ListeningPortsRead;
    try {
      result = await read(known, signal);
    } catch (error) {
      if (stopped()) return;
      throw error;
    }
    if (stopped()) return;
    known = result.generation;
    if (result.ports !== null && (current === undefined || !samePorts(current, result.ports))) {
      current = result.ports;
      onChange(result.ports);
    }
    await wait(LISTENING_PORTS_POLL_MS, signal);
  }
}

/** Resolves after `ms`, or at once when `signal` aborts; never rejects. */
export function pollDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The options of `RuntimeVM.watchListeningPorts`: exactly `{ signal }`. */
export function decodeWatchOptions(options: unknown, method = "watchListeningPorts"): { readonly signal: AbortSignal } {
  if (typeof options !== "object" || options === null || Object.keys(options).length !== 1 || !("signal" in options)
    || !(options.signal instanceof AbortSignal)) {
    throw new VMError("INVALID_ARGUMENT", `${method} needs options with exactly an AbortSignal`);
  }
  return { signal: options.signal };
}

/** Whether two lists name the same ports in the same order. */
export function samePorts(left: readonly ListeningPort[], right: readonly ListeningPort[]): boolean {
  return left.length === right.length && left.every((port, index) => {
    const other = right[index];
    return other !== undefined && port.port === other.port && port.address === other.address
      && port.program === other.program && port.previewable === other.previewable;
  });
}
