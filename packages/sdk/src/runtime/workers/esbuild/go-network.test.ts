import { expect, it, vi } from "vitest";
import type { ProcessExit } from "../../../contracts.js";
import type { LinuxProcessContext } from "../../../js-process-types.js";
import { descriptor, JS_MAILBOX_BYTES, LinuxError } from "../../js-process/codec.js";
import { asyncFiles, syncFiles } from "../../js-process/files.js";
import { process } from "../../js-process/process.js";
import { sockets } from "../../js-process/sockets.js";
import { LinuxClient } from "../../js-process/transport.js";
import { goNetwork } from "./go-network.js";
import { decodeProcessId } from "../../../values.js";

it("cancels blocked accepts through their Rust request identity before closing the descriptor", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES)), filesystem = asyncFiles(client);
  const context: LinuxProcessContext = { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), files: filesystem, filesSync: syncFiles(client), process: process(client), sockets: sockets(client, filesystem) };
  let signal: AbortSignal | undefined;
  vi.spyOn(context.sockets, "accept").mockImplementation((_fd, options) => new Promise((_resolve, reject) => {
    signal = options?.signal;
    signal?.addEventListener("abort", () => { reject(new LinuxError(4)); }, { once: true });
  }));
  const close = vi.spyOn(filesystem, "close").mockImplementation(() => { expect(signal?.aborted).toBe(true); return Promise.resolve(); });
  const adapter = goNetwork(context, client, error => { throw error; });
  try {
    const accepted = Promise.withResolvers<unknown>();
    adapter.accept(7, error => { accepted.resolve(error); });
    expect(signal).toBeInstanceOf(AbortSignal);
    const closed = Promise.withResolvers<unknown>(); adapter.close(7, error => { closed.resolve(error); });
    expect(await accepted.promise).toMatchObject({ errno: 9 }); expect(await closed.promise).toBeNull();
    expect(close).toHaveBeenCalledWith(7);
  } finally { client.dispose(); channel.port2.close(); }
});

it("keeps resolver policy but removes runtime injection hooks from the internal DNS child", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES)), filesystem = asyncFiles(client);
  const context: LinuxProcessContext = { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), files: filesystem, filesSync: syncFiles(client), process: process(client), sockets: sockets(client, filesystem) };
  vi.spyOn(context.process, "info").mockResolvedValue({ pid: decodeProcessId(1), parentPid: null, uid: 1000, gid: 1000, cwd: "/workspace", args: ["esbuild"], terminal: null,
    environment: ["PATH=/usr/bin", "RES_OPTIONS=attempts:1", "NODE_OPTIONS=--require=/workspace/injected.cjs", "NODE_V8_COVERAGE=/workspace/coverage", "LD_PRELOAD=/workspace/preload.so", "OPENSSL_CONF=/workspace/openssl.conf"] });
  const child = { pid: decodeProcessId(2), stdin: descriptor(4), stdout: descriptor(5), stderr: descriptor(6) }, spawn = vi.spyOn(context.process, "spawn").mockResolvedValue(child);
  vi.spyOn(context.process, "wait").mockResolvedValue({ kind: "exited", code: 0 });
  let read = false;
  vi.spyOn(filesystem, "read").mockImplementation(fd => {
    if (fd !== 5 || read) return Promise.resolve(new Uint8Array()); read = true;
    return Promise.resolve(new TextEncoder().encode('{"kind":"addresses","addresses":[{"address":"127.0.0.1","family":4}]}'));
  });
  vi.spyOn(filesystem, "close").mockResolvedValue(undefined);
  vi.spyOn(context.sockets, "socket").mockResolvedValue(descriptor(7)); vi.spyOn(context.sockets, "bind").mockResolvedValue(undefined); vi.spyOn(context.sockets, "listen").mockResolvedValue(undefined);
  vi.spyOn(context.sockets, "address").mockResolvedValue({ family: "ipv4", address: "127.0.0.1", port: 8000 });
  try {
    const listening = Promise.withResolvers<unknown>();
    goNetwork(context, client, listening.reject).listen("tcp", "localhost", 8000, (error, value) => { if (error !== null) listening.reject(new Error(error.message)); else listening.resolve(value); });
    expect(await listening.promise).toMatchObject({ fd: 7, local: "127.0.0.1:8000" });
    expect(spawn.mock.calls[0]?.[0].env).toEqual({ PATH: "/usr/bin", RES_OPTIONS: "attempts:1" });
  } finally { client.dispose(); channel.port2.close(); }
});

it("reaps a resolver whose stdin close fails and closes both remaining pipes once", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES)), filesystem = asyncFiles(client);
  const context: LinuxProcessContext = { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), files: filesystem, filesSync: syncFiles(client), process: process(client), sockets: sockets(client, filesystem) };
  vi.spyOn(context.process, "info").mockResolvedValue({ pid: decodeProcessId(1), parentPid: null, uid: 1000, gid: 1000, cwd: "/workspace", args: ["esbuild"], terminal: null, environment: [] });
  vi.spyOn(context.process, "spawn").mockResolvedValue({ pid: decodeProcessId(2), stdin: descriptor(4), stdout: descriptor(5), stderr: descriptor(6) });
  const exited = Promise.withResolvers<ProcessExit>();
  const wait = vi.spyOn(context.process, "wait").mockReturnValue(exited.promise);
  const kill = vi.spyOn(context.process, "signal").mockImplementation(() => { exited.resolve({ kind: "signaled", signal: "SIGKILL", signalNumber: 9 }); return Promise.resolve(); });
  const close = vi.spyOn(filesystem, "close").mockImplementation(fd => fd === 4 ? Promise.reject(new LinuxError(5)) : Promise.resolve());
  try {
    const result = Promise.withResolvers<unknown>();
    goNetwork(context, client, result.reject).listen("tcp", "localhost", 8000, error => { result.resolve(error); });
    expect(await result.promise).toMatchObject({ errno: 5 });
    expect(kill).toHaveBeenCalledWith(2, 9); expect(wait).toHaveBeenCalledTimes(1);
    expect(close.mock.calls.map(([fd]) => fd)).toEqual([4, 5, 6]);
  } finally { client.dispose(); channel.port2.close(); }
});
