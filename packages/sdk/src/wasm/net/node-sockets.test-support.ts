import { connect, type Socket } from "node:net";
import { LinuxError } from "../../runtime/js-process/codec.js";
import type { NetSockets } from "./ports.js";

/**
 * The module network's asynchronous sockets on Node's TCP, for core tests that run the engine's TLS module against a real
 * TLS server on loopback. Files come from a table; datagrams are not offered.
 */
export function nodeSockets(files: Readonly<Record<string, string>>): NetSockets {
  const sockets = new Map<number, { socket: Socket | null; chunks: Uint8Array[]; ended: boolean; waiter: (() => void) | null }>();
  let next = 3;
  const entry = (fd: number) => { const found = sockets.get(fd); if (found === undefined) throw new LinuxError(9); return found; };
  const wake = (fd: number) => { const found = sockets.get(fd); const waiter = found?.waiter; if (found !== undefined) found.waiter = null; waiter?.(); };
  return {
    stream: () => { const fd = next++; sockets.set(fd, { socket: null, chunks: [], ended: false, waiter: null }); return Promise.resolve(fd); },
    connect: (fd, address) => new Promise((resolve, reject) => {
      if (address.family === "unix") { reject(new LinuxError(111)); return; }
      const state = entry(fd), socket = connect({ host: address.address, port: address.port });
      state.socket = socket;
      socket.on("data", (chunk: Buffer) => { state.chunks.push(new Uint8Array(chunk)); wake(fd); });
      socket.on("end", () => { state.ended = true; wake(fd); });
      socket.on("close", () => { state.ended = true; wake(fd); });
      socket.once("connect", () => { resolve(); });
      socket.once("error", () => { reject(new LinuxError(111)); });
    }),
    read: async (fd, max) => {
      const state = entry(fd);
      while (state.chunks.length === 0 && !state.ended) await new Promise<void>(resolve => { state.waiter = resolve; });
      const head = state.chunks.shift();
      if (head === undefined) return new Uint8Array();
      if (head.length > max) state.chunks.unshift(head.subarray(max));
      return head.slice(0, max);
    },
    write: (fd, bytes) => new Promise((resolve, reject) => { entry(fd).socket?.write(bytes, error => { if (error === undefined || error === null) resolve(bytes.length); else reject(new LinuxError(32)); }); }),
    shutdown: fd => { entry(fd).socket?.end(); return Promise.resolve(); },
    close: fd => { sockets.get(fd)?.socket?.destroy(); sockets.delete(fd); return Promise.resolve(); },
    datagram: () => Promise.reject(new LinuxError(97)),
    sendTo: () => Promise.reject(new LinuxError(97)),
    receiveFrom: () => Promise.reject(new LinuxError(97)),
    readFile: (path, max) => Promise.resolve(Object.hasOwn(files, path) ? new TextEncoder().encode(files[path]).slice(0, max) : null),
  };
}
