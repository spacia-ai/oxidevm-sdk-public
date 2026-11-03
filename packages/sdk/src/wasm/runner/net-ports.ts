import type { FileDescriptor, LinuxFiles, LinuxSyncFiles } from "../../js-process-types.js";
import { descriptor, LinuxError } from "../../runtime/js-process/codec.js";
import { datagram, streamSocket } from "../../runtime/js-process/sockets.js";
import type { LinuxClient } from "../../runtime/js-process/transport.js";
import type { NetPorts, NetSockets, NetSyncSockets } from "../net/ports.js";

/**
 * The module network's ports on the module process's own Linux client (engine ADR 0029): every socket is one of this
 * process's VM sockets, so Rust's socket owner applies the VM's policy and the module's reach to it, and every operation
 * travels on this process's channel with its identity. Writes never raise SIGPIPE (MSG_NOSIGNAL); a closed peer is EPIPE.
 */
const ENOENT = 2, EAGAIN = 11;
/** The most one non-blocking read asks for: the receive operation's own bound. */
const MAX_READ_NOW = 64 * 1024;

/** Descriptors in the module network are this process's own; the brand is restored at the boundary. */
const fd = (value: number): FileDescriptor => descriptor(value);

async function readOptional(files: LinuxFiles, path: string, max: number): Promise<Uint8Array | null> {
  try { return await files.readFile(path, max); } catch (error: unknown) { if (error instanceof LinuxError && error.errno === ENOENT) return null; throw error; }
}

function readOptionalSync(files: LinuxSyncFiles, path: string, max: number): Uint8Array | null {
  try { return files.readFile(path, max); } catch (error: unknown) { if (error instanceof LinuxError && error.errno === ENOENT) return null; throw error; }
}

export function processSockets(client: LinuxClient, files: LinuxFiles): NetSockets {
  return {
    stream: family => client.call(streamSocket.socket(family)),
    connect: (socket, address, signal) => client.call(streamSocket.connect(socket, address), signal),
    read: (socket, max, signal) => files.read(fd(socket), max, signal === undefined ? {} : { signal }),
    write: (socket, bytes, signal) => files.write(fd(socket), bytes, { noSignal: true, ...(signal === undefined ? {} : { signal }) }),
    shutdown: socket => client.call(streamSocket.shutdown(socket, "write")),
    close: socket => files.close(fd(socket)),
    datagram: family => client.call(datagram.socket(family)),
    sendTo: (socket, bytes, destination) => client.call(datagram.sendTo(socket, bytes, destination)),
    receiveFrom: (socket, max, signal) => client.call(datagram.receiveFrom(socket, max), signal),
    readFile: (path, max) => readOptional(files, path, max),
  };
}

export function processSyncSockets(client: LinuxClient, files: LinuxSyncFiles): NetSyncSockets {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  return {
    stream: family => client.sync(streamSocket.socket(family)),
    connect: (socket, address) => { client.sync(streamSocket.connect(socket, address)); },
    read: (socket, max) => files.read(fd(socket), max),
    // recvfrom(MSG_DONTWAIT) on the stream socket: its bytes, empty at the end of stream, EAGAIN when none have arrived.
    readNow: (socket, max) => {
      try { return client.sync(datagram.receiveFrom(socket, Math.min(max, MAX_READ_NOW), { dontWait: true })).bytes; }
      catch (error: unknown) { if (error instanceof LinuxError && error.errno === EAGAIN) return null; throw error; }
    },
    write: (socket, bytes) => files.write(fd(socket), bytes, { noSignal: true }),
    shutdown: socket => { client.sync(streamSocket.shutdown(socket, "write")); },
    close: socket => { files.close(fd(socket)); },
    datagram: family => client.sync(datagram.socket(family)),
    sendTo: (socket, bytes, destination) => client.sync(datagram.sendTo(socket, bytes, destination)),
    receiveNow: (socket, max) => {
      try { return client.sync(datagram.receiveFrom(socket, max, { dontWait: true })); }
      catch (error: unknown) { if (error instanceof LinuxError && error.errno === EAGAIN) return null; throw error; }
    },
    sleep: ms => { Atomics.wait(pause, 0, 0, ms); },
    readFile: (path, max) => readOptionalSync(files, path, max),
  };
}

/** The ports of this process, with the TLS module the broker compiled for it (null when the start carried none). */
export function processNetPorts(client: LinuxClient, files: LinuxFiles, sync: LinuxSyncFiles, tls: WebAssembly.Module | null): NetPorts {
  return { sockets: processSockets(client, files), sync: processSyncSockets(client, sync), tls };
}
